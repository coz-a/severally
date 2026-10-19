# severally のインストールの詳細

<p><a href="install.md">English</a> | 日本語</p>

[README](../README.ja.md#インストール) のインストールの節に入れていない詳細です。ふつうに入れるだけなら、README の 1 行で
足ります。

npx はパッケージを自分のキャッシュに取ってきて、そこからインストーラを動かします。インストーラが入れるサーバと Skill は
そのキャッシュを参照しないので、あとでキャッシュを消しても構いません。

## 必要なもの

README に書いた Node.js 20.10 以降とログイン済みの CLI のほかに、次の条件があります。

- macOS / Linux では、npm のグローバルな実行ファイルのディレクトリが `PATH` に入っていること。既定のプラグイン方式
  （下記）は、Codex が起動する `severally-mcp` コマンドをそこに入れます。`--manual` を付ければ不要です。
- Windows では、PowerShell かコマンドプロンプトからネイティブに動きます。WSL は要りません。CLI は `PATH` と
  `PATHEXT` から探します（`.exe`、`.cmd`、`.bat`、空白を含むパスにも対応します）。

## クローンから入れる

macOS / Linux では、次のコマンドを実行します。

```bash
git clone https://github.com/coz-a/severally.git
cd severally
npm install                 # 依存パッケージを取得する
node scripts/install.mjs    # --dry-run を付けると、何も変えずに変更内容だけを表示する
```

Windows では、PowerShell で次のコマンドを実行します。

```powershell
git clone https://github.com/coz-a/severally.git
cd severally
npm.cmd install
node scripts/install.mjs
```

インストールのあとは、クローンしたフォルダを移しても消しても構いません。Node.js は残しておく必要があります。
`npm run init-config`（README の[設定](../README.ja.md#設定)を参照）を使うなら、フォルダは残してください。

## 登録の確かめ方

クライアントを再起動したあと、それぞれが severally を認識しているかを確かめます。持っていない CLI の行は飛ばしてください。

```bash
# macOS / Linux（プラグイン方式）
claude plugin details severally      # Skills (1) / MCP servers (1)
codex  plugin list                   # severally@severally-local  installed, enabled
# Windows、または --manual（手動方式）
claude mcp get severally
codex  mcp get severally
# 両方の方式で共通
agy      mcp list                    # severally  stdio  enabled
opencode mcp list                    # severally  connected
```

## Claude Code のプラグインマーケットプレイスから入れる

Claude Code だけで使うなら、クローンもインストーラも要りません。Claude Code で次を実行します。

```
/plugin marketplace add coz-a/severally
/plugin install severally@severally
```

Claude Code を再起動し、`claude plugin details severally` で確かめます。プラグインはサーバを `node` で起動するので、
Node.js 20.10 以降が `PATH` に入っている必要があります。ツールは `mcp__plugin_severally_severally__*` の名前で
現れます。この方法を実機で確かめたのは Linux だけです。

Codex、Antigravity、OpenCode からも使うなら、クローンしてインストーラも実行します（[クローンから入れる](#クローンから入れる)を参照）。
インストーラはマーケットプレイス版を見つけると、Claude Code はそちらに任せます。マーケットプレイス版より先に
インストーラを実行していた場合は、もう一度実行してください。そのままだと Claude Code が severally を二重に読み込みます。
インストーラは、自分が以前に入れた Claude Code 用の写しと登録を、バックアップしてから取り除きます。

## 2 つのインストール方式

インストーラは、severally を 2 つの方式のどちらかで登録します。macOS / Linux の既定はプラグイン方式、Windows の
既定は手動方式です。macOS / Linux でも手動方式にするには `--manual` を付けます。

| | プラグイン方式（macOS / Linux の既定） | 手動方式（`--manual`、Windows の既定） |
|---|---|---|
| Claude Code | プラグインを `~/.claude/skills/severally/` に置く（`severally@skills-dir`） | `claude mcp add --scope user` と、Skill の単独のコピー |
| Codex | `~/.severally/marketplace/` に写したマーケットプレイスから `codex plugin add` | `codex mcp add` と、Skill の単独のコピー |
| Antigravity | `agy mcp add` と、Skill の単独のコピー（プラグインの経路が無いので、どちらの方式でも同じ） | 同じ |
| OpenCode | `opencode mcp add severally -- …` と、Skill の単独のコピー（プラグインの仕組みが無いので、どちらの方式でも同じ） | 同じ |
| MCP ツール名 | `mcp__plugin_severally_severally__*` | `mcp__severally__*` |

## インストーラが変えるもの

- サーバを依存パッケージごと `~/.severally/runtime/severally-mcp.mjs` に写します。どの登録も、クローンした
  フォルダではなく、この写しを指します。
- プラグイン方式では、npm のグローバルなインストールも行います。これで、Codex が起動する `severally-mcp` コマンドが
  入ります。`--skip-global` を付けるとこの手順を飛ばしますが、`PATH` 上の `severally-mcp` がすでに写した runtime を
  指している場合しか受け付けません。手動方式ではグローバルなインストールは要りません。
- クライアントの設定は、各 CLI のコマンド（`plugin add` / `mcp add`）だけで変えます。何かをする前に、各クライアントの
  設定ファイル（`~/.claude.json`、`~/.codex/config.toml`、`~/.gemini/config/mcp_config.json` と
  `~/.gemini/antigravity-cli/settings.json`、`~/.config/opencode/opencode.json(c)`）と既存の Skill のディレクトリを、
  `~/.severally/backups/<timestamp>/` にバックアップします。バックアップの名前は元のパスから付けます。
- 方式を切り替えると、もう一方の方式で残った重複の登録を、バックアップしてから取り除きます。
- Claude Code にマーケットプレイス版の severally がすでに入っていれば、Claude Code には登録しません。以前に
  インストーラが入れた Claude Code 用の写し（`~/.claude/skills/severally`）とユーザスコープの登録も取り除きます。
- Codex のマーケットプレイスのファイル `.agents/plugins/marketplace.json` は、このリポジトリから写します。
  公開されているマーケットプレイスは使いません。

## 外に何も送らないツールの許可の確認を省く

`consult_start` 以外の 5 つのツールは手元で完結します。`consult_get`（1 回の相談で何度も呼ぶ）、`consult_list`、
`consult_cancel`、`consult_record`、`consult_export` です。どのクライアントにも許可リストに
ツールを足すコマンドが無いので、インストーラは触りません。手で足してください。`consult_start` は確認を残します。
ほかのベンダーに材料を送るのはこの呼び出しだからです。

- **Claude Code**: Skill が、呼ばれたターンの間はこの 5 つを許可します（`allowed-tools`）。そのため相談のポーリングで
  毎回は確認が出ません。代わりに Skill 自体の承認を 1 度求められます。後のターン（判定の記録や追加質問）でも省くには、
  `~/.claude/settings.json` に書きます（プラグイン方式の場合。`--manual` では
  `mcp__plugin_severally_severally__` を `mcp__severally__` に読み替えます）。
  ```json
  { "permissions": { "allow": [
    "mcp__plugin_severally_severally__consult_get", "mcp__plugin_severally_severally__consult_list",
    "mcp__plugin_severally_severally__consult_cancel", "mcp__plugin_severally_severally__consult_record",
    "mcp__plugin_severally_severally__consult_export"
  ] } }
  ```
- **Codex**: `codex mcp add` で登録したサーバ（`--manual`）なら、`~/.codex/config.toml` にツールごとの表を書きます。
  codex 0.163 がこのキーを受け付けること（値は `auto`、`prompt`、`writes`、`approve`）は確かめましたが、セッションでの
  効き目と、プラグイン方式での動きは確かめていません。
  ```toml
  [mcp_servers.severally.tools.consult_get]
  approval_mode = "approve"
  ```
- **OpenCode** は、自分の `permission` の設定で変えていなければ、MCP ツールを確認なしで使います。
- **Antigravity**: MCP ツールを 1 つずつ許可する規則の書き方を確かめていないので、ここでは扱いません。

## 更新

`npx -y severally-mcp@latest install` を実行します。
クローンから入れた場合は、pull してから `npm install` と `node scripts/install.mjs` をもう一度実行します。
インストーラは新しいサーバの構文を確かめ、前の runtime とマーケットプレイスのファイルを `~/.severally/backups/` に
バックアップしてから置き換えます。そのあとクライアントを再起動します。

クローンしたフォルダそのものを登録していた古いバージョンで入れた場合は、一度だけ `--force` を付けてください。既存の登録が、
写した runtime を指すように切り替わります。付けなければ、既存の登録はそのまま残ります。

マーケットプレイスから入れた場合は、Claude Code で `/plugin marketplace update severally` を実行してから再起動します。
自動の更新は既定では無効です。有効にするには、`/plugin` の Marketplaces で severally を選び、Enable auto-update を
選びます。Codex、Antigravity、OpenCode からも使っている場合は、インストーラも実行し直してください。この 3 つは
`~/.severally/runtime` にある別の写しを使い、どちらの写しも同じ `~/.severally/config.json` を読みます。設定の書き方が
変わるリリースでは、両方を同じバージョンにそろえてください。`~/.severally/runtime` か `~/.claude/skills/severally` の
写しが、答えているサーバと違うバージョンなら、`consult_start` の応答の `stale_install` がそれを知らせます。中身は、
それぞれの写しのバージョンと、そろえるためのコマンドです。

## アンインストール

マーケットプレイスから入れた場合（Claude Code）は、Claude Code で次を実行します。

```
/plugin marketplace remove severally    # プラグインもアンインストールされる
```

Windows（既定の手動方式で入れた場合）は、次のコマンドで取り除きます。

```powershell
claude mcp remove severally -s user
codex mcp remove severally
agy mcp remove severally
# opencode には `mcp remove` が無いので、$HOME/.config/opencode/opencode.json の
# "mcp" オブジェクトから "severally" の項目を消す
Remove-Item -LiteralPath "$HOME/.claude/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.codex/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.gemini/config/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.config/opencode/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.severally/runtime" -Recurse -Force
# 以前にグローバルなコマンドを入れていた場合だけ:
npm.cmd uninstall -g severally-mcp
```

`CODEX_HOME` を設定している場合は、Codex の Skill について `$HOME/.codex` の代わりにそのディレクトリを使います。

macOS / Linux で、プラグイン方式で入れた場合は次のとおりです。

```bash
rm -rf ~/.claude/skills/severally                       # Claude Code
codex plugin remove severally --marketplace severally-local
codex plugin marketplace remove severally-local
agy   mcp remove severally                              # Antigravity（どちらの方式でも直接登録している）
rm -rf ~/.gemini/config/skills/severally
# OpenCode（どちらの方式でも直接登録している。opencode には `mcp remove` が無いので、
# "mcp" オブジェクトから "severally" の項目を手で消す）:
#   ~/.config/opencode/opencode.json(c) を編集する
rm -rf ~/.config/opencode/skills/severally
npm uninstall -g severally-mcp
rm -rf ~/.severally/runtime ~/.severally/marketplace
```

macOS / Linux で、手動方式で入れた場合は次のとおりです。

```bash
claude mcp remove severally -s user
codex  mcp remove severally
agy    mcp remove severally
# opencode: ~/.config/opencode/opencode.json(c) の "mcp" オブジェクトから
# "severally" の項目を手で消す
rm -rf ~/.claude/skills/severally ~/.codex/skills/severally ~/.gemini/config/skills/severally \
       ~/.config/opencode/skills/severally
# 以前にグローバルなコマンドを入れていた場合だけ:
npm uninstall -g severally-mcp
rm -rf ~/.severally/runtime ~/.severally/marketplace
```

どちらの方式でも、履歴とバックアップは `~/.severally/` に残ります（要らなければ消してください）。
