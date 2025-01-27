
// just some magic:

const root = document.location.host.endsWith('.github.io') ? 
  // if hosted on GitHub
  document.location.pathname.split('/').slice(0,2).join('/') :
  // else if localhost
  ''
const script = document.createElement('script')
script.type = 'importmap'
script.textContent = JSON.stringify({
  imports: {
    'rtc-perfect-negotiator': root+'/RTCPerfectNegotiator.js',
    'wrapped-elements': root+'/wrapped-elements/wrapped-elements.js',
    'tiny-peerserver-client': root+'/tiny-peerserver-client/PeerServerSignalingClient.js',
  }
})
document.head.append(script)
