/**
 * Wave 2, package D: the hook scrubber. T4-19: the secret shapes the red team found surviving
 * into the subject. T1-09: the old base64 shape redacted ordinary paths and URLs (38 of 39 real
 * redactions). Every shape is tested both ways: the secret goes, the text around it stays.
 */
import { describe, expect, it } from "vitest";
import { SECRET_SHAPES, scrub, subjectOf } from "../src/hook/subject.ts";

describe("T4-19: secret shapes leave the subject", () => {
  // [shape, command, the secret that must go, text that must stay]
  const cases: readonly (readonly [string, string, string, string])[] = [
    ["curl -u", "curl -u admin:hunter2pass https://api.example.com/v1", "hunter2pass", "admin:"],
    [
      "URL userinfo",
      "psql postgres://app:S3cretPassw0rd@db.internal:5432/prod",
      "S3cretPassw0rd",
      "@db.internal:5432/prod",
    ],
    ["mysql -p", "mysql -u root -pS3cretPassw0rd prod", "S3cretPassw0rd", "mysql -u root -p"],
    [
      "--password value",
      "docker login -u me --password hunter2hunter2 registry.example.com",
      "hunter2hunter2",
      "registry.example.com",
    ],
    ["--token value", "gh auth login --token abcdef1234567890", "abcdef1234567890", "--token "],
    ["--token=value", "tool --token=abcdef1234567890 run", "abcdef1234567890", " run"],
    ["--api-key value", "stripe login --api-key rk_live_abcdefghijklmnop1234", "rk_live_", "login"],
    ["--secret value", "vault write --secret s3cr3tvalue x", "s3cr3tvalue", " x"],
    [
      "env assignment",
      "export OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef",
      "0123456789abcdef0123456789abcdef",
      "OPENROUTER_API_KEY=",
    ],
    ["PGPASSWORD env", "PGPASSWORD=Tr0ub4dor psql -h db prod", "Tr0ub4dor", "psql -h db prod"],
    ["PowerShell env", '$env:GITHUB_TOKEN = "abc123secretvalue"', "abc123secretvalue", "$env:"],
    [
      "bearer header",
      'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"',
      "eyJzdWIiOiIxIn0",
      "Authorization: Bearer ",
    ],
    ["basic header", 'curl -H "Authorization: Basic dXNlcjpwYXNz"', "dXNlcjpwYXNz", "Basic "],
    [
      "AWS secret via CLI",
      "aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      "aws configure set",
    ],
    [
      "AWS access key id",
      "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
      "AKIAIOSFODNN7EXAMPLE",
      "set",
    ],
    [
      "GitHub token in URL",
      "git clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r",
      "ghs_abcdefghijklmnopqrstuvwxyz0123",
      "@github.com/o/r",
    ],
    [
      "Stripe live key",
      "stripe login --api-key rk_live_abcdefghijklmnop1234",
      "rk_live_abcdefghijklmnop1234",
      "stripe",
    ],
    [
      "Stripe secret key",
      "echo sk_live_51Habcdefghijklmnop",
      "sk_live_51Habcdefghijklmnop",
      "echo",
    ],
    [
      "GitHub fine-grained",
      "echo github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "github_pat_",
      "echo",
    ],
    ["GitLab", "echo glpat-abcdefghij0123456789", "glpat-abcdefghij0123456789", "echo"],
    [
      "npm",
      "npm config set //registry.npmjs.org/:_authToken npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "npm_abcdef",
      "npm config set",
    ],
    [
      "Google API key",
      "curl https://x.test?k=AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "AIzaSyA1234567890",
      "curl",
    ],
    ["Slack", "echo xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij", "echo"],
    [
      "JWT",
      "echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop",
      "eyJzdWIiOiIxMjM0NSJ9",
      "echo",
    ],
    [
      "private key",
      "echo '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----' > k",
      "b3BlbnNzaC1rZXktdjEAAAAA",
      "> k",
    ],
    [
      "random blob",
      "echo Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdI",
      "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdI",
      "echo",
    ],
  ];

  it.each(cases)("%s: the secret goes and the rest stays", (_name, command, secret, stays) => {
    const s = scrub(command);
    expect(s.text).not.toContain(secret);
    expect(s.text).toContain(stays);
    expect(s.text).toContain("[redacted]");
    expect(s.redacted).toBe(true);
  });

  it("names every shape it applies", () => {
    const ids = SECRET_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SECRET_SHAPES.every((s) => s.pattern.global)).toBe(true);
  });

  it.each([
    "docker login -u me --password-stdin registry.example.com",
    "psql --no-password -h db prod",
    "tool --token-file ./token.txt run",
    "git push -u origin main",
    "git push -u origin feature:main",
    "mysql -u root -p prod",
    "mysql -P 3306 -h db prod",
    "curl http://localhost:8080/path",
    "curl https://user@example.com/x",
    "TOKENIZERS_PARALLELISM=false python train.py",
    "echo $PWD && OLDPWD=/tmp ls",
    "docker pull node@sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "git log --oneline -5",
  ])("leaves %s alone", (command) => {
    expect(scrub(command)).toEqual({ text: command, redacted: false });
  });
});

describe("T1-09: ordinary paths and URLs are not secrets", () => {
  it.each([
    "cd C:/Users/dev/AppData/Local/Temp/claude/0a1b2c3d4e5f6a7b/9c8d7e6f-aaaa/scratchpad && ls",
    "https://developer.apple.com/tutorials/data/documentation/appkit/nswindow.json",
    "C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\5d4c3b2a19f8e7d6\\a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d\\scratchpad\\blob.ts",
    "/home/dev/projects/ratchet/node_modules/@biomejs/cli-win32-x64/biome.exe",
    "src/components/AccountSettingsNotificationPreferencesPanel.tsx",
    "/c/src/pdf-tools/.venv/Lib/site-packages/pdfminer/cmap/UniJISX02132004-UTF32-H.json.gz",
    "https://github.com/anthropics/claude-code/blob/main/docs/hooks/PermissionRequest.md",
    "/var/lib/docker/overlay2/3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c/merged/usr/share/doc",
  ])("leaves %s unredacted", (text) => {
    expect(scrub(text)).toEqual({ text, redacted: false });
  });

  it("redacts a random segment inside a path and keeps the path around it", () => {
    const s = scrub("cat /tmp/upload/Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdI/part.bin");
    expect(s.text).toBe("cat /tmp/upload/[redacted]/part.bin");
  });

  it("redacts a slash-bearing base64 blob whose pieces are each short", () => {
    const s = scrub("echo Ab3dEf7hIj1kLm/Op2rSt5vWx9Z/aB4cD6eF8gH0");
    expect(s.text).toBe("echo [redacted]");
  });

  it("a path subject is no longer marked redacted for being long", () => {
    const s = subjectOf(
      "Write",
      {
        file_path:
          "C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\C--src-proj\\4f1c2a9e-1b2c-4d3e-8f90-123456789abc\\scratchpad\\notes.md",
        content: "x",
      },
      "C:\\src\\proj",
    );
    expect(s).toMatchObject({ kind: "path", redacted: false });
  });
});

describe("wave 3, item 3: the shapes the verifier still saw leak", () => {
  const value = "plainsecretvalue";
  it.each([
    `curl -d '{"token":"${value}"}' https://x`,
    `curl -d '{"password": "${value}"}' https://x`,
    `curl --data '{"client_secret":"${value}"}' https://x`,
    `curl --data '{"api_key":"${value}","n":1}' https://x`,
    `curl -H "Cookie: session=${value}" https://x`,
    `curl -b "sessionid=${value}" https://x`,
    `curl --cookie sid=${value} https://x`,
    `sshpass -p ${value} ssh host`,
    `sshpass -p${value} ssh host`,
    `docker login -u me -p ${value}`,
    `podman login registry.x -p ${value}`,
    `export DB_PASS=${value}`,
    `SMTP_PASSWORD=${value} node mail.js`,
    `GITLAB_TOKEN=${value} glab mr list`,
    `CLIENT_SECRET=${value} ./run`,
    `curl "https://api.x.example/v1?key=${value}"`,
    `curl "https://api.x.example/v1?page=2&token=${value}"`,
    `curl "https://x.example/cb?access_token=${value}&state=1"`,
    `curl "https://acct.blob.core.windows.net/c/b?sv=2022&sig=${value}"`,
  ])("redacts the value in %s", (command) => {
    const s = scrub(command);
    expect(s.text).not.toContain(value);
    expect(s.redacted).toBe(true);
  });

  it("keeps the shape around a JSON secret and a query key", () => {
    expect(scrub(`{"token":"${value}","n":1}`).text).toBe('{"token":"[redacted]","n":1}');
    expect(scrub(`https://x/v1?page=2&key=${value}#top`).text).toBe(
      "https://x/v1?page=2&key=[redacted]#top",
    );
  });

  it("scrubs a WebSearch query, as the design says", () => {
    const s = subjectOf(
      "WebSearch",
      { query: "why does sk-proj-Zq7xW2mK9pL4vR8tN3bYxx fail" },
      "/w",
    );
    expect(s).toMatchObject({ kind: "query", redacted: true });
    expect(s.kind === "query" && s.query).not.toContain("Zq7xW2");
    expect(subjectOf("WebSearch", { query: "bun test filter" }, "/w")).toEqual({
      kind: "query",
      query: "bun test filter",
      truncated: false,
      redacted: false,
    });
  });
});

describe("wave 3, item 7: scrub false positives", () => {
  it.each([
    "python -u C:\\src\\proj\\run.py",
    "python -u /home/me/run.py",
    "git show 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
    "git cherry-pick 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a 0123456789abcdef0123456789abcdef01234567",
    "gh auth login --with-token < tok.txt",
    "git checkout rk-fix-the-long-branch-name",
    "git checkout -b sk-add-the-new-settings-page",
    "git checkout -b feature/cookie-banner",
    'curl -d \'{"max_tokens": "512", "tokenizer": "bpe"}\' https://x',
    "BYPASS_CACHE=1 npm test",
  ])("leaves %s alone", (command) => {
    expect(scrub(command)).toEqual({ text: command, redacted: false });
  });

  it("still redacts real keys of the prefixed kinds", () => {
    for (const key of [
      "sk-proj-Zq7xW2mK9pL4vR8tN3bYxx",
      "sk-or-v1-0123456789abcdef0123456789abcdef",
      "sk-ant-api03-AbCdEf0123456789GhIjKl",
    ]) {
      expect(scrub(`echo ${key}`).text).toBe("echo [redacted]");
    }
  });
});
