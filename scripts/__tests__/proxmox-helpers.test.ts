import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const script of ["proxmox-server.sh", "proxmox-node.sh"]) {
  describe(script, () => {
    function run(options: { version?: number; failure?: string; storage?: string } = {}) {
      const dir = mkdtempSync(join(tmpdir(), "proxmox-test-"));
      const source = readFileSync(join(import.meta.dir, "../..", script), "utf8").split(
        "# ---------- menu ----------",
      )[0];
      const file = join(dir, "test.sh");
      writeFileSync(
        file,
        `${source}\n
preflight() { :; }
check_server_image() { :; }
pvesh() { echo 201; }
pveversion() { echo pve-manager/${options.version ?? 9}.2.6/example; }
dpkg() { echo amd64; }
pvesm() {
  echo 'Name Type Status Total Used Available %'
  case "$*" in
    *rootdir*) echo 'offline dir inactive 0 0 0 0'; echo 'disks zfspool active 100 0 100 0' ;;
    *vztmpl*) echo 'templates dir active 100 0 100 0' ;;
  esac
}
pveam() {
  case "$1" in
    update) ${options.failure === "catalogue" ? "return 1" : ":"} ;;
    available) printf '%s\\n' 'system debian-12-standard_12.12-1_amd64.tar.zst' 'system debian-13-standard_13.9-1_amd64.tar.zst' 'system debian-13-standard_13.10-1_amd64.tar.zst' ;;
    download) echo "DOWNLOAD $2 $3"; ${options.failure === "download" ? "return 1" : ":"} ;;
  esac
}
pct() { echo "PCT $*"; }
openssl() { echo test-password; }
install_ct
`,
      );
      try {
        const result = Bun.spawnSync(["env", "-u", "SHELLOPTS", "-u", "BASHOPTS", "bash", file], {
          env: {
            ...process.env,
            PVE_NO_PROMPT: "1",
            CT_STORAGE: options.storage ?? "",
            TEMPLATE_STORAGE: "",
            SETUP_URL: "https://example.com/install.sh?setup_key=nsk_test123456",
          },
        });
        return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test("uses active container storage, catalogue version ordering and template storage", () => {
      const result = run();
      expect(result.code).toBe(0);
      expect(result.output).toContain("DOWNLOAD templates debian-13-standard_13.10-1_amd64.tar.zst");
      expect(result.output).toContain("PCT create 201 templates:vztmpl/debian-13-standard_13.10-1_amd64.tar.zst");
      expect(result.output).toContain("--rootfs disks:");
    });

    test("uses Debian 12 on PVE 8", () => {
      expect(run({ version: 8 }).output).toContain("DOWNLOAD templates debian-12-standard_12.12-1_amd64.tar.zst");
    });

    for (const failure of ["catalogue", "download"]) {
      test(`stops before creating a container on ${failure} failure`, () => {
        const result = run({ failure });
        expect(result.code).toBe(1);
        expect(result.output).not.toContain("PCT create");
      });
    }

    test("refuses storage lacking container support", () => {
      const result = run({ storage: "templates" });
      expect(result.code).toBe(1);
      expect(result.output).not.toContain("PCT create");
    });
  });
}

describe("server image preflight", () => {
  for (const failure of ["", "token", "manifest"]) {
    test(failure ? `refuses an unavailable image at ${failure}` : "checks anonymous access to the image tag", () => {
      const source = readFileSync(join(import.meta.dir, "../../proxmox-server.sh"), "utf8").split(
        "# ---------- menu ----------",
      )[0];
      const result = Bun.spawnSync([
        "env",
        "-u",
        "SHELLOPTS",
        "-u",
        "BASHOPTS",
        "bash",
        "-c",
        `${source}
IMG=ghcr.io/subshell-ai/subshell:test
curl() {
  if [[ "$*" == *https://ghcr.io/token* ]]; then
    ${failure === "token" ? "return 22" : `echo '{"token":"test-pull-token"}'`}
  else
    [[ "$*" == *'Authorization: Bearer test-pull-token'* ]] || return 1
    [[ "$*" == *'https://ghcr.io/v2/subshell-ai/subshell/manifests/test'* ]] || return 1
    ${failure === "manifest" ? "return 22" : "return 0"}
  fi
}
check_server_image
`,
      ]);
      expect(result.exitCode).toBe(failure ? 1 : 0);
      if (failure) expect(result.stderr.toString()).toContain("nothing was created");
    });
  }
});

describe("Proxmox server browser address", () => {
  for (const scenario of [
    { ipv4: "10.1.10.215", ipv6: "", override: "", port: "3080", expected: "http://10.1.10.215:3080" },
    { ipv4: "10.1.10.215", ipv6: "", override: "", port: "8080", expected: "http://10.1.10.215:8080" },
    { ipv4: "", ipv6: "2001:db8::42", override: "", port: "3080", expected: "http://[2001:db8::42]:3080" },
    {
      ipv4: "",
      ipv6: "",
      override: "https://subshell.example.com",
      port: "3080",
      expected: "https://subshell.example.com",
    },
    { ipv4: "", ipv6: "", override: "", port: "3080", expected: "" },
  ]) {
    test(scenario.expected || "refuses a container without an address", () => {
      const source = readFileSync(join(import.meta.dir, "../../proxmox-server.sh"), "utf8").split(
        "# ---------- menu ----------",
      )[0];
      const result = Bun.spawnSync([
        "env",
        "-u",
        "SHELLOPTS",
        "-u",
        "BASHOPTS",
        "bash",
        "-c",
        `${source}
pct() {
  case "$*" in
    *'ip -4'*) ${scenario.ipv4 ? `echo '2: eth0 inet ${scenario.ipv4}/24 scope global eth0'` : ":"} ;;
    *'ip -6'*) ${scenario.ipv6 ? `echo '2: eth0 inet6 ${scenario.ipv6}/64 scope global'` : ":"} ;;
  esac
}
CT_ID=108
APP_BASE_URL='${scenario.override}'
APP_PORT=${scenario.port}
container_base_url
`,
      ]);
      expect(result.exitCode).toBe(scenario.expected ? 0 : 1);
      expect(result.stdout.toString().trim()).toBe(scenario.expected);
    });
  }
});

describe("additional Proxmox browser addresses", () => {
  for (const [input, expected] of [
    ["", ""],
    [" 10.1.10.187 , subshell.example.com ", "http://10.1.10.187:8080,http://subshell.example.com:8080"],
    ["https://subshell.example.com,http://10.1.10.187:9090", "https://subshell.example.com,http://10.1.10.187:9090"],
    [
      "2001:db8::42,[2001:db8::43],[2001:db8::44]:9090",
      "http://[2001:db8::42]:8080,http://[2001:db8::43]:8080,http://[2001:db8::44]:9090",
    ],
    [" ,subshell.example.com:9090,,", "http://subshell.example.com:9090"],
  ]) {
    test(input || "blank list", () => {
      const source = readFileSync(join(import.meta.dir, "../../proxmox-server.sh"), "utf8").split(
        "# ---------- menu ----------",
      )[0];
      const result = Bun.spawnSync([
        "env",
        "-u",
        "SHELLOPTS",
        "-u",
        "BASHOPTS",
        "bash",
        "-c",
        `${source}\nAPP_PORT=8080\nnormalize_browser_addresses "$1"`,
        "_",
        input,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(expected);
    });
  }
});
