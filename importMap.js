
// just some magic:
const url = new URL(document.currentScript.src)
const dir = url.pathname.slice(0, url.pathname.lastIndexOf('/'))
const script = document.createElement('script')
script.type = 'importmap'
script.textContent = JSON.stringify({
  imports: {
    'rtc-perfect-negotiator': dir+'/RTCPerfectNegotiator.js',
    'wrapped-elements':       dir+'/wrapped-elements/wrapped-elements.js',
    'tiny-peerserver-client': dir+'/tiny-peerserver-client/PeerServerSignalingClient.js',
  }
})
document.head.append(script)
