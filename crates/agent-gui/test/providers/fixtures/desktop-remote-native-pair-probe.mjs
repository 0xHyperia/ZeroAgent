// Explicit runtime acceptance: two compiled Windows clients, each with its own
// profile, WebView data and synthetic account origin. Real Gateway and Native
// transports/handlers/Go execution; only the external account/model is synthetic.
// Both clients must use user 700127 from loopback ports 19373 and 19375. The RPC
// helper rejects all other account scopes before any model/config/tool mutation.
await import('./native-pair-matrix.mjs');
await import('./native-pair-approval.mjs');
await import('./native-pair-slow-models.mjs');
await import('./native-pair-reconnect.mjs');
console.log('COMPLETE NATIVE PAIR ACCEPTANCE PASS');
