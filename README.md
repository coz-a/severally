# peer-consult

Codex、Claude Code、Antigravity (Gemini) のどれかで作業中に、残りの相手へ判断案を相談し、
「進める前に確かめる項目」を根拠つきで持ち帰る MCP サーバと Skill。

**エージェントが設計変更の案を出し、「進めていいか」と聞いてきた。筋は通って見える。でもレビュアがいない。**

そこで「この移行案を Codex に相談して」と言う。数分後、今のセッションにこう戻る。

- 相手の結論（進める／進めない／別案／判断できず）と、指摘ごとの根拠
- ブリーフに足りなかった情報と、判断が変わる条件
- 「これを確かめれば決まる」という検証案
- 答えが来なかった場合は、その理由（レート制限、認証失敗、時間切れ）

それをリポジトリで確かめて決めるのは主担当（相談した側）。

別のターミナルに手で貼っても近いことはできる。違いは、相手に渡るのがこちらが書いたブリーフで
会話の履歴は渡らないこと、返答が上の形に揃っていて検証候補としてそのまま持ち帰れること、相談中も
今のセッションが止まらないこと（開始は即座に返り、結果は後から取りに行く）。複数に聞いたとき、サーバは答えを
「おおむね一致」にまとめない。相手ごとの結論・根拠・不足情報・失敗の種類を、そのまま並べて返す。

何が返るかの実例と、手貼りや zen-mcp との違いは [docs/concept.md](docs/concept.md)、ツール API・隔離の
実装・設定・上限・既知の制約は [docs/reference.md](docs/reference.md)。

## しくみ

相談は毎回**専用の子セッション**として起動する（既存セッションには接続しない）。相談相手には
**Web 検索・閲覧のみ**を許可し、ファイル変更・コマンド実行・さらなる相談は実行環境レベルで禁止する。
1 回の依頼で最大 3 者に**同一のブリーフ**を投げて 1 つの `group_id` で受け取れるが、一致しているかどうかを
サーバが判定することはない。

```
Claude Code ──(skill: peer-consult)──> mcp: peer-consult ──> codex exec | agy      (Codex / Antigravity)
Codex       ──(skill: peer-consult)──> mcp: peer-consult ──> claude -p  | agy      (Claude Code / Antigravity)
Antigravity ──(skill: peer-consult)──> mcp: peer-consult ──> codex exec | claude -p (Codex / Claude Code)
```

Claude Code と Codex にはプラグインとしてパッケージ済み、Antigravity はインストーラが直接登録する
（いずれも公開マーケットプレイス不要）。

## インストール

```bash
npm install                 # 依存の取得
npm test                    # オフライン検証（実 API 呼び出しなし）
npm run build               # プラグイン内 dist/ を再生成（コミット済みなので通常は不要）
node scripts/install.mjs    # --dry-run で実行計画のみ表示できる
```

確認:

```bash
claude plugin details peer-consult   # Skills (1) / MCP servers (1)
codex  plugin list                   # peer-consult@peer-consult-local  installed, enabled
agy    mcp list                      # peer-consult  stdio  enabled
```

**クライアントは再起動が必要**（起動済みセッションはプラグインを読み直さない）。
プラグインを更新したら `npm run build && node scripts/install.mjs` を再実行する。

### 2 つの方式

| | プラグイン方式（既定） | 手動方式（`--manual`） |
|---|---|---|
| Claude Code | `~/.claude/skills/peer-consult/` にプラグインを配置（`peer-consult@skills-dir`） | `claude mcp add --scope user` ＋ Skill を単体コピー |
| Codex | リポジトリ内 marketplace から `codex plugin add` | `codex mcp add` ＋ Skill を単体コピー |
| Antigravity | `agy mcp add` ＋ Skill を単体コピー（プラグイン経路がないため方式による差はない） | 同左 |
| MCP ツール名 | `mcp__plugin_peer-consult_peer-consult__*` | `mcp__peer-consult__*` |

インストーラは既存設定を保全する。クライアント設定は各 CLI（`plugin add` / `mcp add`）経由でのみ変更し、
`~/.claude.json`・`~/.codex/config.toml`・既存 Skill ディレクトリを `~/.peer-consult/backups/<timestamp>/`
（パス由来のユニークな名前）に退避してから作業する。方式を切り替えると、もう一方の方式で入った重複登録は
バックアップのうえ削除される。

公開マーケットプレイスへの登録は不要。Claude Code は marketplace なしで動き、Codex 用の
`.agents/plugins/marketplace.json` はこのリポジトリ内のローカルファイル。

## 使い方

「Codex に聞いて」「Claude にレビューしてもらって」「セカンドオピニオンが欲しい」といった依頼、
あるいは以下の状況で Skill が起動する。

- 重要な設計判断・巻き戻しにくい選択（アーキテクチャ、データ移行、並行性、セキュリティ）
- 選択肢が拮抗して自力で差がつかないとき
- 同じバグに2回以上失敗して新しい情報が出ていないとき

**小さな修正には使わない。** 1 回の相談で数分と実クォータを消費する。

**初めてなら小さく。** 相手は 1 者、mode は `review`、ブリーフは案を 1 段落と根拠になる事実を数行、
関係する diff かコードの抜粋を 1 つ。それで上に挙げた形の答えが返る。

Skill は「問いと成功条件の整理 → mode 選択 → 資料の添付 → 根拠の確認 → 重要な相違点だけ追加相談 →
採用／不採用／保留の整理 → 確かめた結果の記録」という進行を主担当（呼び出した側）に課す。相談の開始は
即座に返るので、主担当は待つ間も別の作業を続けられる。

ブリーフの書き方、mode（`explore` / `review` / `debate`）の選び方、結果の読み方は Skill が主担当に指示する。
ツールを直接呼ぶ場合の API は [docs/reference.md](docs/reference.md#ツール-api)。

## 設定

**既定では設定不要。** サーバは起動時に `codex` / `claude` / `agy` が PATH にあるかを見て、無い相手を
候補から外す。特定の相手を無効にしたい、モデルを変えたい、実行ファイルのパスを指定したい場合は
`~/.peer-consult/config.json` を 1 つ置く。雛形はその環境向けに生成できる:

```bash
npm run init-config            # ~/.peer-consult/config.json を生成（既存は上書きしない）
```

キーの一覧と優先順位（env > 設定ファイル > 自動検出 > 既定値）は
[docs/reference.md](docs/reference.md#環境ごとの設定1-ファイル)。設定はサーバ起動時に 1 度だけ読むので、
変更後はクライアントを再起動する。

## 使う前に知っておくこと

- 止めているのは、会話の履歴が渡ること、ファイル変更、コマンド実行、MCP、さらなる相談。**ローカルファイルの
  読み取りは止めていない**。Codex の子セッションは read-only のシェルでディスクを読める。Claude Code と
  Antigravity の子セッションは今のところ読み取りツールを持たない。どの相手も空の作業ディレクトリで起動するので
  リポジトリの場所は知らず、見せたい物はブリーフに貼る。詳細は [既知の制約](docs/reference.md#既知の制約)
- 相談相手が失敗した（`usage_limit` / `auth` / `timeout` …）ことと、答えたが根拠が薄いことは別物として
  返る。前者を「問題なしと言った」と読まない
- 履歴は `~/.peer-consult/history/` に残る。1 ラウンドにつき、送ったブリーフ・相手の回答・指摘ごとに
  主担当が書いた検証結果（`consult_record`）が 1 ファイルに揃う。送信するブリーフと結果には資格情報の
  マスキングが掛かる

## アンインストール

プラグイン方式:

```bash
rm -rf ~/.claude/skills/peer-consult                       # Claude Code
codex plugin remove peer-consult --marketplace peer-consult-local
codex plugin marketplace remove peer-consult-local
agy   mcp remove peer-consult                              # Antigravity（直接登録のため方式共通）
rm -rf ~/.gemini/config/skills/peer-consult
npm uninstall -g peer-consult-mcp
```

手動方式:

```bash
claude mcp remove peer-consult -s user
codex  mcp remove peer-consult
agy    mcp remove peer-consult
rm -rf ~/.claude/skills/peer-consult ~/.codex/skills/peer-consult ~/.gemini/config/skills/peer-consult
npm uninstall -g peer-consult-mcp
```

どちらも履歴とバックアップは `~/.peer-consult/` に残る（不要なら削除する）。

## ドキュメント

| | |
|---|---|
| [docs/concept.md](docs/concept.md) | 例で見る使い方、手貼りや zen-mcp との違い、三者の役割、なぜ一致を判定しないのか、いつ使うか、限界と見送ったこと、価値の測り方 |
| [docs/reference.md](docs/reference.md) | 構成、ツール API、mode、結果の構造、失敗分類、権限と隔離、設計原則、設定、上限、検証結果、既知の制約 |
| [docs/experiments/](docs/experiments/) | 設計判断を実機で確かめた記録 |
| [docs/backlog.md](docs/backlog.md) | これからの方針と作業の一覧、作らないこと、未検証のこと |
