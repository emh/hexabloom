globalThis.HEXABLOOM_CONFIG = {
  apiBaseUrl: isLocalDevHost(globalThis.location?.hostname)
    ? ""
    : "https://hexabloom-game.emh.workers.dev"
};

function isLocalDevHost(hostname = "") {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}
