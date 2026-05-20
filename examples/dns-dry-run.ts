import "dotenv/config";
import "reflect-metadata";
import { DO, Stack, DryRun } from "../src/index.js";

@DryRun({ token: process.env.DO_TOKEN! })
class DnsStack extends Stack {
  dns = DO.Domain("example.com")
    .pointer("@", "1.1.1.1")
    .aaaa("ipv6", "2001:db8::1")
    .cname("www", "example.com")
    .txt("txt-rec", "v=spf1 include:_spf.google.com ~all")
    .mx("@", "mail.example.com", 10)
    .srv("_sip._tcp", "sip.example.com", 5060)
    .caa("@", "issue", "letsencrypt.org");
}
