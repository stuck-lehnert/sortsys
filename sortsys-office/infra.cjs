const { main, sandbox } = require("./origins.cjs")();
module.exports = {
  public: { origin: main.origin, sandboxOrigin: sandbox.origin, httpHost: "127.0.0.1", httpPort: 3000, httpSafePort: 3001,
    httpServerId: "", externalWebsocketURL: main.origin.replace(/^http/, "ws") + "/cryptpad_websocket", fileHost: main.origin },
  front: [{ host: "127.0.0.1", port: 3010 }], core: [{ host: "127.0.0.1", port: 3020 }],
  storage: [{ host: "127.0.0.1", port: 3030, wsPort: 3040 }],
};
