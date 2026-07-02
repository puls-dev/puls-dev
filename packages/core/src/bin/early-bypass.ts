import "dotenv/config";
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || process.env.PROXMOX_VERIFY_SSL === "false") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
