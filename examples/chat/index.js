
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
    e.p('A WebRTC example using my RTCPerfectNegotiator and PeerServerSignalingClient classes to do most of the heavy lifting. Current version: 0.20', 
      // e.span('loading...').onceAdded(self => {
      //   fetch('https://api.github.com/repos/JoakimCh/rtc-perfect-negotiator/commits/main')
      //   .then(response => response.json())
      //   .then(data => self.text(data.sha.substring(0, 7)))
      //   .catch(error => self.text('error loading...'))
      // })
    ),
    e.div(
      e.div(
        e.label('My ID:',
          e.input().type('text').tagAndId('input_myId')
          .value(sessionStorage.getItem('myId'))
          .autocapitalize('none')
        ),
        e.label('Peer ID:', 
          e.input().type('text').tagAndId('input_peerId')
          .value(sessionStorage.getItem('peerId'))
          .autocapitalize('none')
        ),
        e.label('Allow using relays around NAT:', 
          e.input().type('checkbox').tagAndId('checkbox_turn')
          .checked('true' == sessionStorage.getItem('checkbox_turn'))
          .on('change', () => sessionStorage.setItem('checkbox_turn', checkbox_turn.checked))
        ).title('configures a TURN server')
      ).className('cleanBreak'),
      e.button('Ready for peer connection').tag('button_ready'),
      e.button('Try to connect').tag('button_connect').disabled(true),
      e.button('Close').tag('button_close').disabled(true),
    ),
    e.div().tagAndId('chat'),
    e.div(
      e.label('Message:', 
        e.input().type('text').tagAndId('input_msg').autocomplete('off')
      ),
      e.button('Send').tag('button_send').disabled(true)
    )
  ).id('container')
))

const {input_myId, input_peerId, button_ready, 
  button_connect, 
  button_close, 
  button_send, input_msg, chat, checkbox_turn} = tags

globalThis['DEBUG_SIGNALING'] = true
const idSuffix = '-jlcRtcTest'
let myId, peerId
/** @type {PeerServerSignalingClient} */
let signalingClient
/** @type {RTCPeerConnection} */
let peerConnection
/** @type {RTCDataChannel} */
let chatChannel
const iceConfig = {
  iceServers: [{
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302',
    ]
  }]
}
// from the PeerJS project: https://github.com/peers/peerjs/blob/master/lib/util.ts
const iceConfigWithTURN = {
  iceServers: [
    ...iceConfig.iceServers, {
      username: 'peerjs',
      credential: 'peerjsp',
      urls: [
        'turn:eu-0.turn.peerjs.com:3478',
        'turn:us-0.turn.peerjs.com:3478',
      ]
    }
  ]
}

// debug = () => {} // to disable debug
/** If enabled debugs to chat, else debug() */
function debugToChat(...messages) {
  debug(...messages)
  displayChatMessage(messages.join(' '))
}

window.addEventListener('offline', () => {
  debugToChat('Network connection offline.')
})
window.addEventListener('online', () => {
  debugToChat('Network connection online.')
})

button_connect.onclick = () => {
  button_connect.disabled = true
  chatChannel = peerConnection.createDataChannel('chat')
  initChatChannel()
}

button_close.onclick = () => {
  button_close.disabled = true
  peerConnection.close()
}

// IDs are decided and we'll wait for a connection (signaling)
button_ready.onclick = async () => {
  chat.replaceChildren() // clear chat
  myId = input_myId.value
  peerId = input_peerId.value
  if (!myId || !peerId) {
    displayChatMessage('Please fill out "my ID" and "peer ID"!')
    return
  }
  button_ready.disabled = true
  input_myId.disabled = true
  input_peerId.disabled = true
  checkbox_turn.disabled = true
  sessionStorage.setItem('myId', myId)
  sessionStorage.setItem('peerId', peerId)
  initPeerConnection(myId, peerId, idSuffix)
}

button_send.onclick = () => {
  const message = input_msg.value
  dataChannel.send(message)
  wrap(input_msg).value('').focus() // (when wrapped we can use chaining)
  displayChatMessage(myId+': '+message)
}

input_msg.onkeydown = ({key}) => {
  if (key == 'Enter') {
    button_send.click()
  }
}

function displayChatMessage(message) {
  const msg = e.p(message)
  chat.append(msg.element)
  msg.scrollIntoView({
    block: 'nearest',
    behavior: 'smooth'
  })
}

function onChatMessage(message) {
  displayChatMessage(peerId+': '+message)
}

/** Since there are no reliable events on the RTCPeerConnection to monitor when it is closed we use a data channel to trigger this when it is closed. */
function onClosed() {
  displayChatMessage('Connection closed...')
  // reset all buttons
  input_myId.disabled = false
  input_peerId.disabled = false
  button_ready.disabled = false
  checkbox_turn.disabled = false
  button_close.disabled = true
  button_send.disabled = true
}

async function initPeerConnection(myId, peerId, suffix) {
  myId += suffix; peerId += suffix
  if (signalingClient) {
    if (!(signalingClient.ready && signalingClient.myId == myId)) {
      signalingClient.reconnect(myId) // if closed or reconnecting with a new ID
    }
  } else { // we only create one client (which can reconnect when needed)
    signalingClient = new PeerServerSignalingClient({myId})
    signalingClient.addEventListener('connecting', ({detail: {connectionAttempt, lastAttempt}}) => {
      displayChatMessage(`Signaling channel connecting... ${connectionAttempt}/${signalingClient.maxConnectionAttempts}`)})
    signalingClient.addEventListener('ready', () => {
      displayChatMessage(`Signaling channel ready.`)})
    signalingClient.addEventListener('closed', ({detail: {willRetry}}) => {
      displayChatMessage(`Signaling channel closed, willRetry: ${willRetry}`)})
    signalingClient.addEventListener('error', ({detail: {message, code}}) => {
      displayChatMessage(`Signaling channel error: ${code} ${message}`)})
  }
  try {
    if (!signalingClient.ready) {
      await signalingClient.createReadyPromise()
    } else {
      displayChatMessage('Signaling channel ready.')
    }
  } catch (error) {
    if (error.code == 'SIGNALING_SERVER_TIMEOUT') {
      displayChatMessage(`Signaling channel connection timeout.`)
    }
    input_myId.disabled = false
    input_peerId.disabled = false
    button_ready.disabled = false
    return
  }
  // signaling server ready
  const signalingChannel = signalingClient.getChannel(peerId)
  const negotiator = new RTCPerfectNegotiator({
    peerConfiguration: (checkbox_turn.checked ? iceConfigWithTURN : iceConfig),
    signalingChannel
  })
  displayChatMessage(`Negotiator isPolite = ${negotiator.isPolite}`)
  negotiator.addEventListener('error', ({detail: {message, code}}) => {
    debugToChat(`error: ${code} (${peerConnection.signalingState}) ${message}`)})
  peerConnection = negotiator.peerConnection
  button_connect.disabled = false // allow chat channel creation
  initPeerConnectionEvents(peerConnection)
  // debug('peerConfiguration:', peerConnection.getConfiguration())
  // (negotiation is not done before a channel or track is added)
}

/**
 * @param {RTCPeerConnection} peerConnection 
 */
function initPeerConnectionEvents(peerConnection) {
  peerConnection.onnegotiationneeded = () => {
    debugToChat('## negotiation needed ##')
  }
  peerConnection.onconnectionstatechange = () => {
    debugToChat('## connection state ##', peerConnection.connectionState)
    switch (peerConnection.connectionState) {
      case 'connected': displayConnectionStats(); break
    }
  }
  peerConnection.onsignalingstatechange = async () => {
    debug('## signaling state ##', peerConnection.signalingState)
  }
  peerConnection.oniceconnectionstatechange = async () => {
    debug('## ICE connection state ##', peerConnection.iceConnectionState)
  }
  peerConnection.ondatachannel = ({channel}) => {
    debug('new data channel:', channel.label, peerConnection.connectionState, peerConnection.signalingState)
    if (!chatChannel && channel.label == 'chat') {
      chatChannel = channel
      initChatChannel()
    }
  }
}

function displayConnectionStats() {
  peerConnection.getStats().then(reports => {
    for (const [id, report] of reports) {
      if (report.type == 'candidate-pair' && report.nominated) {
        const localCandidate = reports.get(report.localCandidateId)
        const remoteCandidate = reports.get(report.remoteCandidateId)
        const [local, remote] = [localCandidate.candidateType, remoteCandidate.candidateType]
        if (localCandidate.candidateType == 'relay' || remoteCandidate.candidateType == 'relay') {
          displayChatMessage(`Relayed connection successful! (${local}, ${remote})`)
        } else {
          displayChatMessage(`Direct connection successful! (${local}, ${remote})`)
        }
      }
    }
  })
}

function initChatChannel() {
  button_connect.disabled = true
  
  chatChannel.onopen = () => {
    debug('chat channel opened')
    input_msg.focus()
    button_send.disabled = false
    button_close.disabled = false
  }
  chatChannel.onmessage = ({data}) => {
    debug('message received:', data)
    if (typeof data == 'string') {
      onChatMessage(data)
    }
  }
  chatChannel.onerror = ({error}) => {
    // this will happen if other side e.g. refresh the tab
    debug('chat channel error:', error)
  }
  chatChannel.onclose = () => {
    debug('chat channel closed:', peerConnection.connectionState, peerConnection.signalingState)
    peerConnection.close() // if it isn't already
    chatChannel = false
    button_connect.disabled = false
    onClosed() // (since there is no reliable events to monitor when a peerConnection is closed we use a data channel to know when)
  }
}
