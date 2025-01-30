
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
export class RTCPerfectNegotiator {
  /** PeerConnection @type {RTCPeerConnection} */
  #pc; #signalingChannel
  #polite; #makingOffer; #ignoreOffer; #isSettingRemoteAnswerPending

  get peerConnection() {return this.#pc}
  get isPolite() {return this.#polite}

  constructor({
    signalingChannel,
    peerConfiguration = DEFAULT_CONFIG,
    peerConnection = new RTCPeerConnection(peerConfiguration), 
  }) {
    this.#pc = peerConnection
    this.#signalingChannel = signalingChannel
    // deterministic politeness based on peer IDs
    this.#polite = signalingChannel.myId > signalingChannel.peerId
    this.#signalingChannel.onSignal = this.#onSignal
    this.#signalingChannel.onExpire = this.#onExpire
    this.#pc.addEventListener('icecandidate', this.#onIceCandidate)
    this.#pc.addEventListener('negotiationneeded', this.#onNegotiationNeeded)
  }

  /** Stop it from handling negotiation. */
  stop() {
    this.#signalingChannel.onSignal = undefined
    this.#signalingChannel.onExpire = undefined
    this.#pc.removeEventListener('icecandidate', this.#onIceCandidate)
    this.#pc.removeEventListener('negotiationneeded', this.#onNegotiationNeeded)
  }

  /** if one or more signals did not get delivered */
  #onExpire = async () => {
    this.stop() // also removes the onExpire callback
    this.#pc.close() // the easiest and most failsafe way to handle this
  }

  #onIceCandidate = ({candidate}) => {
    if (!candidate) return
    this.#signalingChannel.send(candidate)
  }

  #onNegotiationNeeded = () => {
    this.#makeOffer()
  }

  // if undefined it creates one for us
  async #makeOffer(offer) {
    try {
      this.#makingOffer = true
      await this.#pc.setLocalDescription(offer) // create offer
      this.#signalingChannel.send(this.#pc.localDescription)
    } catch (error) {
      console.error('Error making offer:', error)
    } finally {
      this.#makingOffer = false
    }
  }

  // only one side should do this I guess?
  async restartIce() {
    // this.#makeOffer({iceRestart: true})
    try {
      this.#makingOffer = true
      const restartOffer = await this.#pc.createOffer({iceRestart: true})
      await this.#pc.setLocalDescription(restartOffer)
      this.#signalingChannel.send(restartOffer)
      // await peerConnection.setLocalDescription({iceRestart: true})
      // signalingChannel.send(peerConnection.localDescription)
    } catch (error) {
      console.error('Error making offer:', error)
    } finally {
      this.#makingOffer = false
    }
  }

  // copy of https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
  #onSignal = async ({description, candidate}) => {
    try {
      if (description) {
        const readyForOffer = !this.#makingOffer
          && (this.#pc.signalingState == 'stable' || this.#isSettingRemoteAnswerPending)
        const offerCollision = description.type == 'offer' && !readyForOffer
        this.#ignoreOffer = !this.#polite && offerCollision
        if (this.#ignoreOffer) {
          return
        }
        this.#isSettingRemoteAnswerPending = description.type == 'answer'
        await this.#pc.setRemoteDescription(description) // SRD rolls back as needed
        this.#isSettingRemoteAnswerPending = false
        if (description.type == 'offer') {
          await this.#pc.setLocalDescription()
          this.#signalingChannel.send(this.#pc.localDescription)
        }
      } else if (candidate) {
        try {
          await this.#pc.addIceCandidate(candidate)
        } catch (error) {
          if (!this.#ignoreOffer) throw error // suppress ignored offer's candidates
        }
      }
    } catch (error) {
      console.error('Error handling signal:', error)
    }
  }

}
