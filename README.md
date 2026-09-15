# severally

*Independent opinions, returned severally. The verdict is yours.*

コーディングエージェントが人に「この案で進めていいか」と聞く場面で使う MCP サーバと Skill。エージェントは
別の CLI（Codex、Claude Code、Gemini を使う Antigravity）に意見を聞き、返ってきた指摘を手元で確かめてから、
あらためて人に判断を求める。

名前は法律用語の *jointly and severally*（連帯して、かつ各自が個別に）から取った。複数に聞いても答えは
まとめず、相手ごとに返す。どれを採るかは読む側が決める。

## 例: 自作ツールを公開する前に

AI CLI の会話履歴を、プロジェクトフォルダの移動に合わせて書き換える小さなツールを作った。GitHub と PyPI に
出す前に「公開前に必ず潰すべきものは何か」を 3 者に同時に聞くと、2 分ほどで相手ごとの答えが並んで戻った
（抜粋）。

```
codex        do_not_proceed  フォルダの移動と複数の設定ファイルの更新について、途中で失敗したときの扱いが無い
antigravity  do_not_proceed  LICENSE が無い。--force が「稼働中チェックの無視」と「フォルダの統合」を兼ねている
claude-code  proceed         公開してよい。ただし LICENSE の追加や作者のローカルパスの除去など 5 件を先に
```

3 者が挙げたブロッカーは大きく重なっているのに、結論は割れた。差は「直してから出せ」か「直せば出してよい」
かにある。この差は、答えを 1 つにまとめると消える。

相談したエージェント（以下、主担当）は、指摘を読んで終わりにしない。自分のリポジトリで確かめる。

```
codex の指摘     途中で失敗したときの扱いが必要
  確かめた       移動先が移動元の内側にあると、例外のトレースバックで落ちる。
                 さらに、途中でロールバックしたのに exit 0 で終わるバグが見つかった
  判断           失敗を数えて 0 以外で終了し、再実行を案内する修正を公開前の作業に入れた

antigravity の指摘  大きな履歴ファイルを丸ごとメモリに読むので、メモリ不足で落ちる
  確かめた       手元で最大のファイルは 43.8 MB。読み込み方は直すが、重大度は下げた
```

人に返るのは「賛成 1・反対 2」という票ではない。確かめた結果と推薦、まだ確かめていない項目の一覧だ。
確かめた結果は指摘の隣に残り、Markdown にしてリポジトリに置ける。

## 手で貼るのと比べて

別のターミナルにブリーフを貼っても、似たことはできる。severally で増えるのは次の 3 つ。

- **渡るのはブリーフ 1 通だけ。** 相手は毎回新しい子セッションで起動し、こちらの会話の履歴は届かない。
  案を伏せて聞く `explore` では、案を渡す項目（`proposal`）を使えない
- **答えが相手ごとに同じ形で届く。** 結論、指摘と根拠、足りなかった情報、判断が変わる条件、確かめ方。
  答えが来なかったときは、その理由（レート制限、認証失敗、時間切れ）。複数に聞いても要約しない
- **確かめた結果を、指摘の隣に書き戻せる。** 指摘ごとに「確認できた／当てはまらない／確認できない／
  未確認」と判断への影響を残し、Markdown にできる

Codex、Claude Code、Antigravity のどれから使っても、残りの 2 つに聞ける。

## しくみ

相談のたびに専用の子セッションを起動する。既存のセッションには接続しない。相手に渡るのはこちらが書いた
ブリーフだけで、会話の履歴は渡らない。1 回の依頼で最大 3 者に同一のブリーフを送り、1 つの `group_id` で
受け取れる。相手に許すことと止めることは「使う前に知っておくこと」にまとめた。

```
Claude Code ──(skill: severally)──> mcp: severally ──> codex exec | agy      (Codex / Antigravity)
Codex       ──(skill: severally)──> mcp: severally ──> claude -p  | agy      (Claude Code / Antigravity)
Antigravity ──(skill: severally)──> mcp: severally ──> codex exec | claude -p (Codex / Claude Code)
```

Claude Code と Codex にはプラグインとして入り、Antigravity にはインストーラが直接登録する。どちらも公開
マーケットプレイスは不要。

## インストール

```bash
npm install                 # 依存の取得
npm test                    # オフライン検証（実 API 呼び出しなし）
npm run build               # プラグイン内 dist/ を再生成（コミット済みなので通常は不要）
node scripts/install.mjs    # --dry-run で実行計画のみ表示できる
```

確認:

```bash
claude plugin details severally      # Skills (1) / MCP servers (1)
codex  plugin list                   # severally@severally-local  installed, enabled
agy    mcp list                      # severally  stdio  enabled
```

**クライアントは再起動が必要**（起動済みのセッションはプラグインを読み直さない）。
プラグインを更新したら `npm run build && node scripts/install.mjs` を再実行する。

### 2 つの方式

| | プラグイン方式（既定） | 手動方式（`--manual`） |
|---|---|---|
| Claude Code | `~/.claude/skills/severally/` にプラグインを配置（`severally@skills-dir`） | `claude mcp add --scope user` ＋ Skill を単体コピー |
| Codex | リポジトリ内 marketplace から `codex plugin add` | `codex mcp add` ＋ Skill を単体コピー |
| Antigravity | `agy mcp add` ＋ Skill を単体コピー（プラグイン経路がないため方式による差はない） | 同左 |
| MCP ツール名 | `mcp__plugin_severally_severally__*` | `mcp__severally__*` |

インストーラは既存の設定を壊さない。クライアントの設定は各 CLI のコマンド（`plugin add` / `mcp add`）経由で
しか変更しない。作業の前に `~/.claude.json`、`~/.codex/config.toml`、既存の Skill ディレクトリを
`~/.severally/backups/<timestamp>/` に退避する。退避したファイルの名前は、元のパスから作る。方式を切り替えると、
もう一方の方式で入った重複登録はバックアップしたうえで削除される。

公開マーケットプレイスへの登録は不要。Claude Code はマーケットプレイスなしで動き、Codex 用の
`.agents/plugins/marketplace.json` はこのリポジトリ内のローカルファイル。

## 使い方

「Codex に聞いて」「Claude にレビューしてもらって」「セカンドオピニオンが欲しい」といった依頼、
あるいは次の状況で Skill が起動する。

- 重要な設計判断・巻き戻しにくい選択（アーキテクチャ、データ移行、並行性、セキュリティ、公開前の点検）
- 選択肢が拮抗して自力で差がつかないとき
- 同じバグの修正に 2 回以上失敗し、新しい情報が出ていないとき

「みんなで相談して」「全員に聞いて」なら、他の 2 つの CLI に加えて、自分と同じ CLI の新しいセッションにも、
同じブリーフが同時に届く。同じ CLI からの回答には「同じ系統」の注記が付く。

巻き戻しにくい変更の承認を求めるときは、エージェントの方から「相談してから進めるか」を選択肢に出す。
始めるかどうかは人が決める。

**小さな修正には使わない。** 1 回の相談で数分と実クォータを消費する。

**ふだんの相談は小さくてよい。** 相手は 1 者。ブリーフは、案が 1 段落、根拠になる事実が数行、関係する
コードの抜粋が 1 つ。Skill は、返ってきた指摘のうち判断を左右するものを 1 つ確かめる。そのうえで、
確かめたこと・採らなかったこと・まだ確かめていないことを報告し、確かめた結果を指摘の隣に保存する。
相談を始めるとすぐに制御が戻るので、待つ間も作業を続けられる。

**後から理由を問われる判断**（インターフェース、移行、セキュリティ、並行性）では、Skill が段取りを足す。
問いと成功条件を整理し、外から課された制約と自分の仮定を分けて書き、相談の前に予想を残し、記録を
Markdown にしてリポジトリに置く。

ブリーフの書き方、mode（`explore` / `review` / `debate`）の選び方、結果の読み方は Skill が主担当に指示する。

## 設定

**既定では設定不要。** サーバは起動時に `codex` / `claude` / `agy` が PATH にあるかを見て、無い相手を
候補から外す。特定の相手を無効にしたい、モデルを変えたい、実行ファイルのパスを指定したい場合は
`~/.severally/config.json` を 1 つ置く。雛形は、手元の環境に合わせて生成できる。

```bash
npm run init-config            # ~/.severally/config.json を生成（既存は上書きしない）
```

使えるキーは [config.example.json](config.example.json) にある。優先順位は、環境変数 > 設定ファイル >
自動検出 > 既定値。設定はサーバ起動時に 1 度だけ読むので、変更後はクライアントを再起動する。

## 使う前に知っておくこと

**相手に渡らないもの**は、こちらの会話の履歴。**どの相手にもできないこと**は次の 4 つ。

- 書き込み
- ネットワーク（Web の検索と閲覧だけは許す）
- MCP
- さらなる相談

**読み取りは止めていない**。子セッションごとの内訳:

| 相談相手 | ディスクの読み取り | シェル | 書き込み・実行 |
|---|---|---|---|
| Codex | できる | read-only で持つ | 不可 |
| Claude Code | できる（`Read` / `Glob` / `Grep`） | 持たない | 不可 |
| Antigravity | できる（`read_file`） | 持たない | 不可 |

どの相手も空の作業ディレクトリで起動し、サーバはリポジトリの場所を教えない。見せたい物はブリーフに貼る。

- 相談相手が失敗した（`usage_limit` / `auth` / `timeout` …）ことと、答えたが根拠が薄いことは、別物として
  返る。失敗は「問題なし」ではない
- 履歴は `~/.severally/history/` に残る。1 ラウンドにつき 1 ファイルに、送ったブリーフ、相手の回答、主担当が
  指摘ごとに書いた検証結果（`consult_record` で書く）が揃う。`consult_export` で Markdown にしてリポジトリに
  残せる。検証結果は後日、別のセッションからも書き足せる
- 送るブリーフと返ってくる結果には、資格情報のマスキングが掛かる
- 記録には、相談を頼んだのが人か、エージェントの提案を人が受けたのかも残る（自己申告）。人が断った提案は
  `~/.severally/history/offers.jsonl` に 1 行ずつ残る。どちらも何かを制限することはない
- 自分と同じ CLI の別モデルにも聞ける（Opus で作業中に Fable へ、`target: "claude:fable"`）。返答には
  「同じ系統」の注記が付く。`caller_model` で自分のモデルを申告すると、記録に「誰が誰に聞いたか」が残る
- 主担当が自分で実行して確かめられる項目が多く返るのは、コードの判断についての相談だ。プロジェクト方針に
  ついての相談では他の人に頼る項目が返り、それは未実行のまま人に返る

## アンインストール

プラグイン方式:

```bash
rm -rf ~/.claude/skills/severally                       # Claude Code
codex plugin remove severally --marketplace severally-local
codex plugin marketplace remove severally-local
agy   mcp remove severally                              # Antigravity（直接登録のため方式共通）
rm -rf ~/.gemini/config/skills/severally
npm uninstall -g severally-mcp
```

手動方式:

```bash
claude mcp remove severally -s user
codex  mcp remove severally
agy    mcp remove severally
rm -rf ~/.claude/skills/severally ~/.codex/skills/severally ~/.gemini/config/skills/severally
npm uninstall -g severally-mcp
```

どちらの方式でも、履歴とバックアップは `~/.severally/` に残る（不要なら削除する）。
