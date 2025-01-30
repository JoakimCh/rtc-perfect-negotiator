
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

/** Handling the WebRTC 'perfect negotiation' pattern. */
export class RTCPerfectNegotiator extends EventTarget {
  /** PeerConnection @type {RTCPeerConnection} */
  #pc; #signalingChannel
  /** deterministic politeness based on peer IDs */
  #isPolite
  /** Has created an offer and is pending an answer or offer timeout. */
  #pendingOffer; #offerTimeout; #offerRollbackTimer

  get peerConnection() {return this.#pc}
  get isPolite() {return this.#isPolite}

  constructor({
    signalingChannel,
    peerConfiguration = DEFAULT_CONFIG,
    peerConnection = new RTCPeerConnection(peerConfiguration),
    offerTimeout = 5000
  }) {
    super()
    this.#pc = peerConnection
    this.#signalingChannel = signalingChannel
    this.#isPolite = signalingChannel.myId > signalingChannel.peerId
    this.#offerTimeout = offerTimeout
    this.#start()
  }

  #start() {
    this.#signalingChannel.onSignal = this.#onSignal
    this.#signalingChannel.onExpire = this.#onExpire
    this.#pc.addEventListener('icecandidate', this.#onIceCandidate)
    this.#pc.addEventListener('negotiationneeded', this.#onNegotiationNeeded)
    this.#pc.addEventListener('iceconnectionstatechange', this.#onIceConnectionStateChange)
  }

  /** Stop it from handling negotiation. */
  stop() {
    this.#signalingChannel.onSignal = undefined
    this.#signalingChannel.onExpire = undefined
    this.#pc.removeEventListener('icecandidate', this.#onIceCandidate)
    this.#pc.removeEventListener('negotiationneeded', this.#onNegotiationNeeded)
    this.#pc.removeEventListener('iceconnectionstatechange', this.#onIceConnectionStateChange)
  }

  /** if one or more signals did not get delivered */
  #onExpire = async () => {
    this.stop() // also removes the onExpire callback
    this.#pc.close() // the easiest and most failsafe way to handle this
  }

  #onIceConnectionStateChange = () => {
    if (this.#pc.iceConnectionState == 'disconnected' 
    ||  this.#pc.iceConnectionState == 'failed') {
      this.restartIce()
    }
  }

  #onIceCandidate = ({candidate}) => {
    if (!candidate) return
    this.#signalingChannel.send(candidate)
  }

  #onNegotiationNeeded = () => {
    this.#makeOffer()
  }

  #emitError(error) {
    this.dispatchEvent(new CustomEvent('error', {detail: error}))
  }

  /** To rollback an unanswered offer. */
  #beginOfferTimeout() {
    this.#offerRollbackTimer = setTimeout(() => {
      if (!this.#pendingOffer) return
      this.#pendingOffer = false
      if (this.#pc.signalingState == 'have-local-offer') {
        this.#pc.setLocalDescription({type: 'rollback'})
      }
    }, this.#offerTimeout)
  }
  
  async #makeOffer({iceRestart} = {}) {
    if (this.#pendingOffer) {
      if (this.#pc.signalingState != 'have-local-offer') {
        console.error('## pendingOffer but not have-local-offer ##')
      }
      this.#emitError({
        code: 'NEGOTIATION_DUPLICATE_OFFER',
        message: 'Tried sending another offer before getting an answer.'
      })
      return
    }
    try {
      let offer
      this.#pendingOffer = true
      if (iceRestart) {
        offer = await this.#pc.createOffer({iceRestart: true})
      }
      await this.#pc.setLocalDescription(offer) // create offer
      // if we got here it means no error during creation
      this.#beginOfferTimeout() // so we must rollback if no answer received
      this.#signalingChannel.send(offer || this.#pc.localDescription)
    } catch (error) {
      this.#pendingOffer = false
      this.#emitError({
        code: 'NEGOTIATION_OFFER_ERROR',
        message: 'Error during offer creation.',
        cause: error
      })
    }
  }

  // only one side should do this I guess?
  async restartIce() {
    this.#makeOffer({iceRestart: true})
  }

  // copy of https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
  #onSignal = async ({description, candidate}) => {
    try {
      if (description) {
        if (!(description?.type && description?.sdp)) {
          return this.#emitError({
            code: 'NEGOTIATION_RECEIVED_INVALID_SIGNAL',
            message: 'Invalid signal received, missing "type" or "sdp".'
          })
        }
        if (description.type == 'offer') { // received offer
          if (!this.#pendingOffer || this.#isPolite) {
            if (this.#pendingOffer) { // then discard it (the rollback happens below)
              clearTimeout(this.#offerRollbackTimer)
              this.#pendingOffer = false
            }
            await this.#pc.setRemoteDescription(description) // rolls back as needed
            await this.#pc.setLocalDescription()
            this.#signalingChannel.send(this.#pc.localDescription) // send answer
          } else {
            // we ignore the incoming offer because we sent one and we're not the polite peer
          }
        } else if (description.type == 'answer') { // received answer'
          if (this.#pendingOffer && this.#pc.signalingState != 'have-local-offer') {
            console.error('## pendingOffer but not have-local-offer ##')
          }
          if (this.#pc.signalingState != 'have-local-offer') { // did not expect one
            return this.#emitError({
              code: 'NEGOTIATION_UNEXPECTED_ANSWER',
              message: 'Answer signal received without a pending offer.'
            })
          }
          this.#pendingOffer = false // no longer pending then
          await this.#pc.setRemoteDescription(description) // use answer
        } else {
          return this.#emitError({
            code: 'NEGOTIATION_RECEIVED_INVALID_SIGNAL',
            message: 'Invalid signal received, invalid type: '+description.type
          })
        }
      } else if (candidate) { // received a candidate
        try {
          await this.#pc.addIceCandidate(candidate)
        } catch (error) {
          // should be safe to ignore
          this.#emitError({
            code: 'NEGOTIATION_ADD_CANDIDATE_ERROR',
            message: 'Error adding candidate.',
            cause: error
          })
        }
      }
    } catch (error) {
      console.error('Error handling signal:', error)
    }
  }

}
