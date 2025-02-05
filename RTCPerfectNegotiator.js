
const DEFAULT_CONFIG = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
      ]
    }
    // find your own TURN servers if you need them
  ]
}

/** For automatic handling of "perfect negotiation" and connection recovery (e.g. during a network change).
 * @param {object} config
 * @param {*} config.signalingChannel The channel to use for signaling between the two peers.
 * @param {RTCPeerConnection} config.peerConnection The `RTCPeerConnection` to use, else it creates one.
 * @param {object} config.peerConfiguration The configuration to use if no `peerConnection` is provided.
 * @param {object} config.retryTimeout The delay before re-sending the signaling related to an offer or an answer if it hasn't been applied by the other side (which could happen if they lost connection to the signaling server).
 * @param {object} config.maxRetries The amount of tries before rolling back its own offer or answer.
 */
export class RTCPerfectNegotiator extends EventTarget {
  /** PeerConnection @type {RTCPeerConnection} */
  #pc; #signalingChannel
  /** deterministic politeness based on peer IDs */
  #isPolite
  /** Is creating an offer (there is a slight delay before signalingState == 'have-local-offer'). */
  #creatingOffer; #resendTimer; #resendAttempt; #maxRetries; #retryTimeout
  /** Done in case we detect that the peer has not received them, so we can resend them. */
  #outgoingSignalCache = new Set()
  #settingAnswerPending; #iceRestartTimer

  get peerConnection() {return this.#pc}
  get isPolite() {return this.#isPolite}

  constructor({
    signalingChannel,
    peerConfiguration = DEFAULT_CONFIG,
    peerConnection = new RTCPeerConnection(peerConfiguration),
    retryTimeout = 5000,
    maxRetries = 12
  }) {
    super()
    this.#pc = peerConnection
    this.#signalingChannel = signalingChannel
    this.#isPolite = signalingChannel.myId > signalingChannel.peerId
    this.#retryTimeout = retryTimeout
    this.#maxRetries = maxRetries
    this.#start()
  }

  #start() {
    this.#signalingChannel.onSignal = this.#onSignal
    this.#pc.addEventListener('icecandidate', this.#onIceCandidate)
    this.#pc.addEventListener('negotiationneeded', this.#onNegotiationNeeded)
    this.#pc.addEventListener('signalingstatechange', this.#onSignalingStateChange)
    this.#pc.addEventListener('iceconnectionstatechange', this.#onIceConnectionStateChange)
    document.addEventListener('visibilitychange', this.#onNavigatorOnlineAndVisibilityChange)
    window.addEventListener('online', this.#onNavigatorOnlineAndVisibilityChange)
  }

  /** Stop it from handling negotiation. */
  stop() {
    this.#signalingChannel.onSignal = undefined
    this.#pc.removeEventListener('icecandidate', this.#onIceCandidate)
    this.#pc.removeEventListener('negotiationneeded', this.#onNegotiationNeeded)
    this.#pc.removeEventListener('signalingstatechange', this.#onSignalingStateChange)
    this.#pc.removeEventListener('iceconnectionstatechange', this.#onIceConnectionStateChange)
    document.removeEventListener('visibilitychange', this.#onNavigatorOnlineAndVisibilityChange)
    window.removeEventListener('online', this.#onNavigatorOnlineAndVisibilityChange)
  }

  #onNavigatorOnlineAndVisibilityChange = () => {
    if (document.hidden) return
    if (this.#resendAttempt == this.#maxRetries // e.g. it gave up
    || (this.#pc.iceConnectionState == 'failed' && this.#pc.signalingState != 'closed')) {
      this.restartIce()
    }
  }

  /** This is done automatically on 'iceConnectionState' == 'disconnected'. */
  async restartIce() {
    if (this.#iceRestartTimer) return // already scheduled then
    if (!navigator.onLine) { 
      this.#iceRestartTimer = true // since we're waiting for 'online'
      window.addEventListener('online', () => { // wait til online
        this.#timedIceRestart(1000) // let the connection settle
      }, {once: true})
      return // do not restart if offline
    }
    if (this.#pc.signalingState == 'stable') {
      this.#makeOffer({iceRestart: true})
    }
  }

  #timedIceRestart(milliseconds = 2000) {
    this.#iceRestartTimer = setTimeout(() => {
      this.#iceRestartTimer = false
      if (this.#pc.iceConnectionState == 'disconnected' 
      ||  this.#pc.iceConnectionState == 'failed') {
        this.restartIce()
      }
    }, milliseconds)
  }

  #onIceConnectionStateChange = () => {
    if (this.#pc.iceConnectionState == 'disconnected' 
    ||  this.#pc.iceConnectionState == 'failed') {
      if (this.#iceRestartTimer) return
      // try avoiding both attempting a restart at the same time
      if (!this.#isPolite) {
        this.restartIce()
      } else {
        this.#timedIceRestart()
      }
    }
  }

  #onNegotiationNeeded = () => {
    this.#makeOffer()
  }

  #onIceCandidate = ({candidate}) => {
    if (!candidate) return
    this.#sendSignal(candidate)
  }

  #emitError(error) {
    this.dispatchEvent(new CustomEvent('error', {detail: error}))
  }

  #onSignalingStateChange = () => {
    switch (this.#pc.signalingState) {
      // e.g. when our answer has been applied
      case 'stable': this.#clearResendTimer(); break
    }
  }

  /** Send an outgoing signal. */
  #sendSignal(signal) {
    this.#outgoingSignalCache.add(signal)
    this.#signalingChannel.send(signal)
  }

  /** Resend cached outgoing signals (but do not clear them). */
  #resendCachedSignals() {
    this.#resendAttempt ++
    for (const signal of this.#outgoingSignalCache) {
      this.#signalingChannel.send(signal)
    }
  }

  /** Attempt to resend the signals related to the next offer or answer if the connection doesn't go to stable. */
  #beginResendTimer(reset = true) {
    if (reset) {
      this.#resendAttempt = 0
      this.#outgoingSignalCache.clear()
    }
    this.#clearResendTimer()
    this.#resendTimer = setTimeout(this.#onResendTimer, this.#retryTimeout)
  }

  // /** Clear the resend timer. */
  #clearResendTimer() {
    if (this.#resendOnOnlineEvent) {
      window.removeEventListener('online', this.#resendOnOnlineEvent)
      this.#resendOnOnlineEvent = false
    }
    clearTimeout(this.#resendTimer)
    this.#resendTimer = false
  }

  #resendOnOnlineEvent

  /** Check if we should resend our signals. */
  #onResendTimer = () => {
    switch (this.#pc.signalingState) {
      // case 'stable': return // then all is good (handled in #onSignalingStateChange)
      case 'have-local-offer':    // a pending offer has not been answered
      case 'have-local-pranswer': // our answer has not been applied (from what we can infer)
        if (this.#resendAttempt < this.#maxRetries) {
          if (!navigator.onLine) {
            // schedule resend when online?
            if (!this.#resendOnOnlineEvent) { // if not already waiting
              this.#resendOnOnlineEvent = () => {
                this.#resendOnOnlineEvent = false
                this.#onResendTimer()
              }
              window.addEventListener('online', this.#resendOnOnlineEvent, {once: true})
            }
            return // no offline resend
          }
          this.#emitError({
            code: 'NEGOTIATION_SIGNAL_RESEND',
            message: 'Resending signals since not yet stable.'
          })
          this.#beginResendTimer(false) // only restart timer (no reset)
          this.#resendCachedSignals()
        } else { // max attempt reached
          // then roll back our offer or answer and pray...
          this.#emitError({
            code: 'NEGOTIATION_FAILURE',
            message: 'Max signal resend reached, rolling back our offer or answer; hoping for a miracle...'
          })
          this.#pc.setLocalDescription({type: 'rollback'})
        }
      return
    }
  }

  async #makeOffer({iceRestart} = {}) {
    if (this.#creatingOffer || this.#pc.signalingState != 'stable') {
      return this.#emitError({
        code: 'NEGOTIATION_OFFER_OUT_OF_TURN',
        message: 'Tried creating an offer when signalingState not stable.'
      })
    }
    try {
      let offer // undefined == create and apply a normal offer
      this.#creatingOffer = true
      if (iceRestart) {
        offer = await this.#pc.createOffer({iceRestart: true})
      }
      await this.#pc.setLocalDescription(offer) // apply offer (have-local-offer)
      if (this.#pc.signalingState != 'have-local-offer') {
        throw Error(`signalingState != 'have-local-offer'`)
      }
      // if we got here it means no error during creation
      this.#beginResendTimer() // so we can rollback if no answer received
      // this.#sendSignal(offer || this.#pc.localDescription)
      this.#sendSignal(this.#pc.localDescription)
    } catch (error) {
      this.#emitError({
        code: 'NEGOTIATION_OFFER_ERROR',
        message: 'Error during offer creation.',
        cause: error
      })
    } finally {
      this.#creatingOffer = false
    }
  }
  
  // Inspired by https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
  #onSignal = async ({description, candidate}) => {
    if (this.#pc.signalingState == 'closed') {
      return this.#emitError({
        code: 'NEGOTIATION_SIGNAL_WHEN_CLOSED',
        message: 'The connection is closed, but still received a signal.'
      })
    }
    try {
      if (description) { // received offer or answer
        if (!(description?.type && description?.sdp)) {
          return this.#emitError({
            code: 'NEGOTIATION_RECEIVED_INVALID_SIGNAL',
            message: 'Invalid signal received, missing "type" or "sdp".'
          })
        }
        if (this.#resendTimer) {
          this.#clearResendTimer() // (channel is online)
        }
        switch (description.type) {
          case 'offer': { // received offer
            if (this.#iceRestartTimer) { // then skip sending our own ice restart offer
              clearTimeout(this.#iceRestartTimer); this.#iceRestartTimer = false
            }
            const readyForOffer = !this.#creatingOffer && (this.#pc.signalingState == 'stable' || this.#settingAnswerPending)
            // const hasOwnOffer = this.#creatingOffer || this.#pc.signalingState == 'have-local-offer'
            if (readyForOffer || this.#isPolite) { // (!hasOwnOffer || this.#isPolite) 
              // this.#clearResendTimer() // in case our offer will be rolled back
              this.#settingAnswerPending = true
              await this.#pc.setRemoteDescription(description) // rolls back own offer if needed (have-remote-offer)
              this.#settingAnswerPending = false
              await this.#pc.setLocalDescription() // creates an answer (have-local-pranswer)
              this.#beginResendTimer() // to check that our answer is applied and takes us to 'stable'
              this.#sendSignal(this.#pc.localDescription) // send answer
            } else {
              // we ignore the incoming offer because we're not the polite peer
            }
          } return
          case 'answer': // received answer
            if (this.#pc.signalingState != 'have-local-offer') { // did not expect one
              return this.#emitError({
                code: 'NEGOTIATION_UNEXPECTED_ANSWER',
                message: 'Answer signal received without a pending offer.'
              })
            }
            // this.#clearResendTimer() // since our offer has been answered
            await this.#pc.setRemoteDescription(description) // use answer (have-remote-pranswer)
            // (this should take us to 'stable')
          return
          default: return this.#emitError({
            code: 'NEGOTIATION_RECEIVED_INVALID_SIGNAL',
            message: 'Invalid signal received, invalid type: '+description.type
          })
        }
      } else if (candidate) { // received an ICE candidate
        try {
          await this.#pc.addIceCandidate(candidate)
        } catch (error) { // should be safe to ignore
          return this.#emitError({
            code: 'NEGOTIATION_ADD_CANDIDATE_ERROR',
            message: 'Error adding candidate.',
            cause: error
          })
        }
      }
    } catch (error) {
      return this.#emitError({
        code: 'NEGOTIATION_UNKNOWN_ERROR',
        message: 'An unexpected error happened during negotiation.',
        cause: error
      })
    }
  }

}
