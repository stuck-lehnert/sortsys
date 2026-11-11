const path = require("node:path");
const root = "/cryptpad", data = "/var/lib/sortsys-office";
module.exports = {
  ...require(path.join(root, "config/config.example.js")), clientRoot: root,
  installMethod: "docker", disableIntegratedEviction: true, restrictRegistration: true,
  enableEmbedding: true, logIP: false, logLevel: "warn", removeDonateButton: true,
  basePath: data, logoPath: path.join(data, "logo"), challengePath: "/tmp/sortsys-office-challenges",
  filePath: path.join(data, "datastore"), archivePath: path.join(data, "archive"), pinPath: path.join(data, "pins"),
  taskPath: path.join(data, "tasks"), blockPath: path.join(data, "block"), blobPath: path.join(data, "blob"),
  blobStagingPath: path.join(data, "blobstage"), decreePath: path.join(data, "decrees"), logPath: path.join(data, "logs"),
};
