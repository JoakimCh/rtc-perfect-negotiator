
import {RTCPerfectNegotiator} from 'rtc-perfect-negotiator'
import {PeerServerSignalingClient} from 'tiny-peerserver-client'
import {debug, pageSetup, e, tags, wrap, unwrap} from 'wrapped-elements'

pageSetup({
  title: 'Chat Example',
  allowDarkTheme: false, // skip the style injection for this
  stylesheets: 'style.css',
  favicon: false // set to a blank one
})

document.body.append(...unwrap(
  e.div(
    e.h1('Chat Example'),
    e.p('A WebRTC example using my RTCPerfectNegotiator and PeerServerSignalingClient classes to do most of the heavy lifting.'),
    e.div(
      e.div(
        e.label('My ID: ', e.input().type('text').tagAndId('input_myId').value(sessionStorage.getItem('myId'))),
        e.label('Peer ID: ', e.input().type('text').tagAndId('input_peerId').value(sessionStorage.getItem('peerId'))), e.br(),
      ).className('cleanBreak'),
      e.button('Ready for peer connection').tagAndId('button_ready'),
      e.button('Create chat channel').tagAndId('button_create').disabled(true),
      e.button('Close').tagAndId('button_close').disabled(true), e.br(),
    ),
    e.div().tagAndId('chat'),
    e.div(
      e.label('Message: ', e.input().type('text').tagAndId('input_msg').autocomplete('off').onceAdded(self => self.focus())),
      e.button('Send').tagAndId('button_send').disabled(true)
    )
  ).id('container')
))

const {input_myId, input_peerId, button_ready, button_create, button_close, button_send, input_msg, chat} = tags

wrap(button_close).on('click', () => {
  wrap(button_close).disabled(true)
  dataChannel.close()
})

// IDs are decided and we'll wait for a connection (signaling)
wrap(button_ready).on('click', async () => {
  wrap(button_ready).disabled(true)
  wrap(input_myId).disabled(true)
  wrap(input_peerId).disabled(true)
  myId = wrap(input_myId).value()
  peerId = wrap(input_peerId).value()
  sessionStorage.setItem('myId', myId)
  sessionStorage.setItem('peerId', peerId)
  initPeerConnection(myId, peerId, idSuffix)
})

wrap(button_create).on('click', async () => {
  const channel = peerConnection.createDataChannel('chat')
  peerConnection.ondatachannel({channel}) // must trigger it manually then
})

wrap(button_send).on('click', () => {
  const message = wrap(input_msg).value()
  wrap(input_msg).value('')
  dataChannel.send(message)
  displayChatMessage(myId+': '+message)
})

globalThis['DEBUG_SIGNALING'] = true
const idSuffix = '-jlcRtcTest'
let myId, peerId
/** @type {PeerServerSignalingClient} */
let signalingClient
/** @type {RTCPeerConnection} */
let peerConnection
/** @type {RTCDataChannel} */
let dataChannel
const peerConfiguration = {
	iceServers: [
		{
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
      ]
    }, { // from the PeerJS project: https://github.com/peers/peerjs/blob/master/lib/util.ts
      username: 'peerjs',
      credential: 'peerjsp',
      urls: [
				'turn:eu-0.turn.peerjs.com:3478',
				'turn:us-0.turn.peerjs.com:3478',
			]
		}
	]
}

function displayChatMessage(message) {
  wrap(chat).add(e.p(message))
}

function onChatMessage(message) {
  displayChatMessage(e.p(peerId+': '+message))
}

/** Since there are no reliable events on the RTCPeerConnection to monitor when it is closed we use a data channel to trigger this when it is closed. */
function onClosed() {
  debug('connection closed')
  // reset all buttons
  wrap(input_myId).disabled(false)
  wrap(input_peerId).disabled(false)
  wrap(button_ready).disabled(false)
  wrap(button_create).disabled(true)
  wrap(button_close).disabled(true)
  wrap(button_send).disabled(true)
}

async function initPeerConnection(myId, peerId, suffix) {
  myId += suffix; peerId += suffix
  if (signalingClient) {
    if (!(signalingClient.ready && signalingClient.myId == myId)) {
      signalingClient.reconnect(myId)
    }
  } else {
    signalingClient = new PeerServerSignalingClient({myId})
  }
  try {
    if (!signalingClient.ready) {
      await signalingClient.createReadyPromise()
    }
  } catch (error) {
    wrap(button_ready).disabled(false)
    throw error
  }
  // signaling server ready
  signalingClient.addEventListener('closed', () => {
    // wrap(button_ready).disabled(false)
  }, {once: true})
  const signalingChannel = signalingClient.getChannel(peerId)
  const negotiator = new RTCPerfectNegotiator({
    signalingChannel, peerConfiguration
  })
  peerConnection = negotiator.peerConnection
  initPeerConnectionEvents(peerConnection)
  debug('signaling channel opened')
  wrap(button_create).disabled(false)
  // negotiation is not done before a channel or track is added
}

/**
 * @param {RTCPeerConnection} peerConnection 
 */
function initPeerConnectionEvents(peerConnection) {
  peerConnection.ondatachannel = ({channel}) => { // addEventListener('datachannel'
    debug('new data channel:', channel.label, peerConnection.connectionState, peerConnection.signalingState)
    dataChannel = channel
    wrap(button_create).disabled(true)
    let closeTimeout, hasBeenOpen
    const openTimeout = setTimeout(() => {
      debug('data channel open timeout', peerConnection.connectionState, peerConnection.signalingState)
      closeTimeout = setTimeout(() => {
        // sometimes the close event doesn't happen on channel.close(), hence we need to trigger it manually then
        debug('data channel forced close event', peerConnection.connectionState, peerConnection.signalingState)
        channel.onclose?.()
      }, 1000)
      channel.close()
    }, 2000)
    channel.onmessage = ({data}) => {
      debug('data received:', data)
      if (typeof data == 'string') {
        onChatMessage(data)
      }
    }
    channel.onopen = () => {
      debug('data channel opened')
      clearTimeout(openTimeout)
      hasBeenOpen = true
      displayChatMessage(peerId+' has entered the chat.')
      wrap(button_send).disabled(false)
      wrap(button_close).disabled(false)
      wrap(input_msg).focus(true)
    }
    channel.onerror = ({error}) => {
      // this will happen if other side e.g. refresh the tab
      debug('data channel error:', error)
      debug(error)
    }
    channel.onclose = () => {
      debug('data channel closed:', peerConnection.connectionState, peerConnection.signalingState)
      clearTimeout(openTimeout)
      clearTimeout(closeTimeout)
      if (hasBeenOpen) {
        displayChatMessage(peerId+' has left the chat.')
      } else {
        displayChatMessage(`Unable to connect to: ${peerId}...`)
      }
      peerConnection.close() // if it isn't already
      onClosed() // (since there is no reliable events to monitor when a peerConnection is closed we use a data channel to know when)
    }
  }
}
