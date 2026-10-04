import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      // Server: 40 G default (2026-10-03 ENOSPC report) - a pull needs old+new
      // images at full unpacked size, and thin storage charges only for what is
      // written. Node: 4 G, it runs no image cache.
      expect(result.output).toContain(`--rootfs disks:${script === "proxmox-server.sh" ? 40 : 4}`);
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

describe("Proxmox server update reclaims disk around the pull", () => {
  // The 2026-10-03 operator report: a routine update died mid-extraction with
  // "no space left on device" at 6 G free, because every prior update left its
  // replaced image on disk and the pull needs room for old and new at full
  // unpacked size. update_app now prunes dangling images before the pull, and
  // again after the old container is gone, and a failed pull must say the
  // disk's state and both ways out instead of only docker's one word.
  function runUpdate(pullFail: boolean) {
    const source = readFileSync(join(import.meta.dir, "../../proxmox-server.sh"), "utf8").split(
      "# ---------- menu ----------",
    )[0];
    const dir = mkdtempSync(join(tmpdir(), "proxmox-update-"));
    const log = join(dir, "docker.log");
    writeFileSync(
      join(dir, "runenv"),
      "IMAGE=ghcr.io/subshell-ai/subshell:latest\nNAME=subshell\nAPP_PORT=3080\nDATA=/var/lib/subshell\n",
    );
    try {
      const result = Bun.spawnSync(
        [
          "env",
          "-u",
          "SHELLOPTS",
          "-u",
          "BASHOPTS",
          "bash",
          "-c",
          `${source}
preflight() { :; }
need_ct_id() { :; }
CT_ID=108
CT_RUN_ENV='${dir}/runenv'
pct() { case "$1" in
  exec) shift 3; [[ "$1" == -- ]] && shift; "$@" ;;
  fstrim) echo "pct $*" >> "$LOG" ;;
esac; }
df() { case "$*" in
  *--output=avail*) echo 6100000 ;;
  *) echo "/dev/sim 20G 14G 6.1G 70% /var/lib/docker" ;;
esac; }
docker() {
  echo "docker $*" >> "$LOG"
  case "$1 $2" in
    "pull "*) return ${pullFail ? 1 : 0} ;;
    "exec "*) echo "subshell-server 9.9.9" ;;
  esac
  return 0
}
curl() { return 0; }
fstrim() { echo "fstrim $*" >> "$LOG"; return 0; }
# update_app hands the real work to pct exec, which in this harness is a
# CHILD bash reading the heredoc. Functions do not cross into a child unless
# they are exported - unexported, the remote silently called the host's real
# docker and curl, and the health poll looped against a closed port.
# (No backticks in this comment: it lives inside a JS template literal.)
export -f df docker curl fstrim
export LOG
update_app
`,
        ],
        { env: { ...process.env, LOG: log } },
      );
      const calls = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
      return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a successful update prunes before the pull and again once the old container is gone", () => {
    const r = runUpdate(false);
    expect(r.code).toBe(0);
    expect(r.out).toContain("subshell-server 9.9.9");
    const prunes = r.calls.map((c, i) => [c, i] as const).filter(([c]) => c === "docker image prune -f");
    expect(prunes.length).toBe(2);
    const pullAt = r.calls.findIndex((c) => c.startsWith("docker pull "));
    const oldGoneAt = r.calls.findIndex((c) => c === "docker rm -f subshell-old");
    const trimAt = r.calls.findIndex((c) => c === "fstrim -av");
    const hostTrimAt = r.calls.findIndex((c) => c.startsWith("pct fstrim 108"));
    expect(trimAt).toBeGreaterThan(-1);
    // The host-side trim is the one an unprivileged CT can actually do:
    // FITRIM EPERMs inside the guest. It precedes even the remote reclaim.
    expect(hostTrimAt).toBeGreaterThan(-1);
    expect(hostTrimAt).toBeLessThan(prunes[0][1]);
    expect(pullAt).toBeGreaterThan(prunes[0][1]); // the pre-pull reclaim precedes the extraction
    expect(pullAt).toBeGreaterThan(trimAt); // the thin-pool TRIM too: df's free space can be a lie
    expect(prunes[1][1]).toBeGreaterThan(oldGoneAt); // the post-success one follows the old container's removal
  });

  test("a failed pull leaves the container untouched and names the disk's state and both remedies", () => {
    const r = runUpdate(true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pull failed: the running container was left alone");
    expect(r.err).toContain("/var/lib/docker"); // the filesystem it failed on, in its own words
    expect(r.err).toContain("docker image prune -a -f");
    expect(r.err).toContain("fstrim"); // the lvm-thin class: freed blocks reach the pool only via TRIM
    expect(r.err).toContain("pct resize 108");
    expect(r.calls.some((c) => c.startsWith("docker rename"))).toBe(false);
  });
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
