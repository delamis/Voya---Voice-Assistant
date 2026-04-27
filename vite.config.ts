// @ts-nocheck
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const certPath = path.resolve("certs/lan-cert.pem");
const keyPath = path.resolve("certs/lan-key.pem");
const hasLanCertificate = fs.existsSync(certPath) && fs.existsSync(keyPath);
const lanAddress = getPrivateLanAddress();

export default defineConfig({
  plugins: [react()],
  define: {
    __LAN_ADDRESS__: JSON.stringify(lanAddress),
  },
  server: {
    host: "0.0.0.0",
    https: hasLanCertificate
      ? {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        }
      : undefined,
    proxy: {
      "/v1": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});

function getPrivateLanAddress() {
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter(isPrivateIpv4);

  return (
    addresses.find((address) => address.startsWith("192.168.")) ??
    addresses.find((address) => address.startsWith("10.")) ??
    addresses.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) ??
    addresses[0] ??
    ""
  );
}

function isPrivateIpv4(address: string) {
  return (
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  );
}
