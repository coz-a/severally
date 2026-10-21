# severally のインストールの詳細

<p><a href="install.md">English</a> | 日本語</p>

[README](../README.ja.md#インストール) のインストールの節に入れていない詳細です。ふつうに入れるだけなら、README の 1 行で
足ります。

npx はパッケージを自分のキャッシュに取ってきて、そこからインストーラを動かします。インストーラが入れるサーバと Skill は
そのキャッシュを参照しないので、あとでキャッシュを消しても構いません。

## 必要なもの

README に書いた Node.js 22 以降とログイン済みの CLI のほかに、次の条件があります。

- macOS / Linux では、npm のグローバルのフォルダについて必要なことはありません。既定のプラグイン方式（下記）は
  `npm install -g` で、Codex のプラグインが起動する `severally-mcp` コマンドを `PATH` に置きます。npm がグローバルに
  入れられないとき（たとえば sudo が要る、npm のグローバルのフォルダが `PATH` に無い）は、インストーラが代わりに
  Codex を直接登録します。ほかに必要なことはありません。`--manual` を付ければ、このコマンドは要りません。
- Windows では、PowerShell かコマンドプロンプトからネイティブに動きます。WSL は要りません。CLI は `PATH` と
  `PATHEXT` から探します（`.exe`、`.cmd`、`.bat`、空白を含むパスにも対応します）。

## コマンドライン

```bash
npx -y severally-mcp@2.6.0 install [--dry-run] [--manual] [--force] [--skip-global] [--allow-local-tools]
```

| オプション | すること |
|---|---|
| `--dry-run` | 何を変えるかを表示するだけで、何も変えない |
| `--manual` | プラグインを入れる代わりに、MCP サーバを登録して Skill を写す（Windows の既定） |
| `--force` | すでに登録してあっても、そのままにせず登録し直す |
| `--skip-global` | プラグイン方式で npm のグローバルなインストールを飛ばす。`PATH` 上の `severally-mcp` がすでにこのインストールを指しているときだけ使える |
| `--allow-local-tools` | severally の手元で完結する 5 つのツールを、確認なしで Claude Code の許可リストに足す。`consult_start` は確認を残す |


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

`npx -y severally-mcp@latest status` を実行すると、相談を始めずに、まとめて確かめられます。設定ファイルが正しいか、
この機械から使える相談相手（使えないものはその理由）、入っている写しの版がそろっているか、どのクライアントに
severally が登録されているか、各 CLI にログインしているかを表示します。ログインの確認は、各 CLI 自身の状態確認
コマンドを読むだけで、プロンプトは送りません。Claude Code は `claude auth status`、Codex は `codex login status` です。
OpenCode は `opencode auth list` で保存されている認証情報の数を見ます（環境変数のキーでも動くので、保存が無くても
警告にとどめます）。Antigravity にはそうしたコマンドが無いので「not checked」と表示します。使用枠を使い切って
いないかは確かめません。それは最初の相談で分かります。

クライアントごとに自分で確かめるときは、再起動したあとに次を実行します。持っていない CLI の行は飛ばしてください。

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
Node.js 22 以降が `PATH` に入っている必要があります。ツールは `mcp__plugin_severally_severally__*` の名前で
現れます。この方法を実機で確かめたのは Linux だけです。

Codex、Antigravity、OpenCode からも使うなら、クローンしてインストーラも実行します（[クローンから入れる](#クローンから入れる)を参照）。
インストーラはマーケットプレイス版を見つけると、Claude Code はそちらに任せます。マーケットプレイス版より先に
インストーラを実行していた場合は、もう一度実行してください。そのままだと Claude Code が severally を二重に読み込みます。
インストーラは、自分が以前に入れた Claude Code 用の写しと登録を、バックアップしてから取り除きます。マーケットプレイス版が
入ったあとは、同じインストーラの実行でそれも更新されます（[更新](#更新)を参照）。

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
- macOS / Linux のプラグイン方式では、runtime を `severally-runtime` というパッケージ名で npm のグローバルにも入れます。
  これで、Codex のプラグインが起動する `severally-mcp` コマンドが入ります。以前のインストールが残した `severally-mcp`
  という名前のグローバルなパッケージは、先に `npm uninstall -g severally-mcp` で取り除きます。npm がコマンドを
  グローバルに入れられないとき、または `PATH` の先頭にないときも、インストーラは止まらず、代わりに Codex を直接
  登録して、そう表示します。登録は `--manual` と同じ `codex mcp add` で、長い `consult_get` の待ちも同じです。
  `--skip-global` を付けるとグローバルなインストールを飛ばしますが、`PATH` 上の `severally-mcp` がすでに写した
  runtime を指している場合しか受け付けません。手動方式ではグローバルなインストールは要りません。
- クライアントの設定は、各 CLI のコマンド（`plugin add` / `mcp add`）だけで変えます。例外は手動で登録する Codex で、
  `config.toml` の `[mcp_servers.severally]` の表に `tool_timeout_sec = 660` の 1 行も書きます（Codex のプラグインと
  同じ長い待ちにするためで、`codex mcp add` では設定できません）。表にすでに `tool_timeout_sec` があれば、その値を
  残し、待ち時間もそれに合わせます。1 行を書けなければ、長い待ちなしで Codex を登録し、そう表示します。
- 何かをする前に、各クライアントの設定ファイル（`~/.claude.json`、`~/.codex/config.toml`、`~/.gemini/config/mcp_config.json` と
  `~/.gemini/antigravity-cli/settings.json`、`~/.config/opencode/opencode.json(c)`）と既存の Skill のディレクトリを、
  `~/.severally/backups/<timestamp>/` にバックアップします。バックアップの名前は元のパスから付けます。
- 方式を切り替えると、もう一方の方式で残った重複の登録を、バックアップしてから取り除きます。
- Claude Code にマーケットプレイス版の severally がすでに入っていれば、Claude Code には登録しません。以前に
  インストーラが入れた Claude Code 用の写し（`~/.claude/skills/severally`）とユーザスコープの登録も取り除きます。
  マーケットプレイス版の更新も行います（[更新](#更新)を参照）。
- 最後に、Claude Code があり、`~/.claude/settings.json` が severally の手元で完結する 5 つのツールをまだ許可して
  いなければ、足すかどうかを訊きます（次の節を参照）。このファイルのほかの部分は変えません。
- Codex のマーケットプレイスのファイル `.agents/plugins/marketplace.json` は、このリポジトリから写します。
  公開されているマーケットプレイスは使いません。

## 外に何も送らないツールの許可の確認を省く

`consult_start` 以外の 5 つのツールは手元で完結します。`consult_get`（相談が動いている間、繰り返し呼ぶ）、`consult_list`、
`consult_cancel`、`consult_record`、`consult_export` です。`consult_start` は確認を残します。ほかのベンダーに材料を
送るのはこの呼び出しなので、インストーラも足しません。

- **Claude Code**: Skill が、呼ばれたターンの間はこの 5 つを許可します（`allowed-tools`）。そのため相談のポーリングで
  毎回は確認が出ません。代わりに Skill 自体の承認を 1 度求められます。後のターン（判定の記録や追加質問）でも省くために、
  インストーラが足すかどうかを訊きます。インストールの最後に、Claude Code があり、`~/.claude/settings.json` が
  この 5 つをまだ許可していなければ、端末で「Let Claude Code run ... without asking each time? [Y/n]」と訊きます
  （既定は Y）。`--allow-local-tools` を付けると、訊かずに足します（スクリプトからのインストール向け）。端末が無く、
  フラグも無いときは何も変えず、フラグを付けてやり直す方法を表示します。先に `settings.json` をバックアップし、
  ほかの設定は残し、同じ規則を二重には足しません。規則の接頭辞は、プラグイン方式とマーケットプレイス版では
  `mcp__plugin_severally_severally__`、手動方式では `mcp__severally__` です。手で足すときは、
  `~/.claude/settings.json` に次を書きます（`--manual` では `mcp__plugin_severally_severally__` を
  `mcp__severally__` に読み替えます）。
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

インストーラは、Codex・Antigravity・OpenCode の許可には触りません。

### 相談の開始の確認も省く

エージェントは自分から相談します（相談するかどうかを訊かないよう Skill が指示しています）。そのため `consult_start` の
確認を残すと、エージェントが始める相談のたびに 1 回あなたの確認を待ちます。この確認は、材料が手元を離れる前の
唯一の歯止めなので、既定では残します。省くときは、上のツールと同じ書き方で `consult_start` も足します。
Claude Code なら許可リストに `mcp__plugin_severally_severally__consult_start` を、Codex なら `config.toml` に
`[mcp_servers.severally.tools.consult_start]` の表を書きます（`--manual` で登録した場合。プラグイン方式では確かめていません）。

そうすると、どの相談でも次のものが、あなたに訊かずに各相談相手のモデルへ送られます。ブリーフ、渡したファイル、
相談相手が実行中に読んだものです（[相談相手が読めるものとできること](../README.ja.md#相談相手が読めるものとできること)）。
エージェントが触れるものがすべてそのベンダーに渡ってよい環境でだけ、省いてください。

## 更新

開発中のクローンでは、`npm run build` のあとに `node scripts/install.mjs` を再実行すると、
生成したサーバとSkillを各クライアントのインストール先に反映できます。既存の直接登録を置き換える必要がある場合は `--force` を付けます。実行後はクライアントを再起動してください。


`npx -y severally-mcp@latest install` を実行します。
クローンから入れた場合は、pull してから `npm install` と `node scripts/install.mjs` をもう一度実行します。
インストーラは新しいサーバの構文を確かめ、前の runtime とマーケットプレイスのファイルを `~/.severally/backups/` に
バックアップしてから置き換えます。そのあとクライアントを再起動します。

クローンしたフォルダそのものを登録していた古いバージョンで入れた場合は、一度だけ `--force` を付けてください。既存の登録が、
写した runtime を指すように切り替わります。付けなければ、既存の登録はそのまま残ります。

マーケットプレイスから入れた場合は、Claude Code にマーケットプレイス版の severally がすでに入っていれば、インストーラが
`claude plugin marketplace update severally` と `claude plugin update severally@<マーケットプレイス名>` も実行します。
そのため `npx -y severally-mcp@latest install` を 1 回実行すれば、すべての写しが同じバージョンになります。失敗したときは、
Claude Code の中で実行するコマンド `/plugin marketplace update severally` を表示します。そのあと Claude Code を
再起動してください。Claude Code だけなら、インストーラの代わりにこのコマンドを自分で実行しても構いません。
自動の更新は既定では無効です。有効にするには、`/plugin` の Marketplaces で severally を選び、Enable auto-update を
選びます。Codex、Antigravity、OpenCode は `~/.severally/runtime` にある別の写しを使い、どちらの写しも同じ
`~/.severally/config.json` を読みます。インストーラが両方を同じバージョンにそろえます。設定の書き方が変わる
リリースでは、これが大事になります。`~/.severally/runtime` か `~/.claude/skills/severally` の
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
# 以前にグローバルなコマンドを入れていた場合だけ（古い名前は以前のインストール用）:
npm.cmd uninstall -g severally-runtime
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
npm uninstall -g severally-runtime
npm uninstall -g severally-mcp    # 以前のインストールが残していた場合だけ
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
# 以前にグローバルなコマンドを入れていた場合だけ（古い名前は以前のインストール用）:
npm uninstall -g severally-runtime
npm uninstall -g severally-mcp
rm -rf ~/.severally/runtime ~/.severally/marketplace
```

どちらの方式でも、履歴とバックアップは `~/.severally/` に残ります（要らなければ消してください）。
