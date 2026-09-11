# peer-consult

別の CLI（Codex、Claude Code、Antigravity (Gemini) のいずれか）に設計案を読ませて反証を出させ、判断を
左右する検証を 1 件こちらで確かめた結果か、手元では確かめられない理由を添えて、人に「進めていいか」を
返す MCP サーバと Skill。

**エージェントが設計変更の案を出し、「進めていいか」と聞いてきた。筋は通って見える。でもレビュアがいない。**

そこで「この移行案を Codex に相談して」と言う。巻き戻しにくい変更なら、エージェントの側から「相談してから
進めるか」と選択肢を出す。数分後、今のセッションにこう戻る。

- 相手の結論（進める／進めない／別案／判断できず）と、指摘ごとの根拠
- ブリーフに足りなかった情報と、判断が変わる条件
- 「これを確かめれば決まる」という検証案
- 答えが来なかった場合は、その理由（レート制限、認証失敗、時間切れ）

主担当（相談した側）はそのうち判断を左右する検証を 1 つ選び、リポジトリで実行し、**確かめた結果と、まだ
確かめていない項目を添えて**「進めていいか」に戻る。実際に戻った形（2026-09-10、Keras→PyTorch 移植計画を
2 者に同時に相談。全文は [docs/concept.md](docs/concept.md)）:

```
codex        stance: do_not_proceed      antigravity  stance: proceed
両者が挙げた編集      「2018 年の手法を再現する」は受け入れ基準にならない。学習データと
                      チェックポイントは失われている。構造の一致と合成信号での検証を完了条件にせよ
decision_changers     元の学習データが見つかったら → 受け入れ基準を「重みの変換と数値の許容誤差」に
next_checks           nn.LSTM(1,64)/(64,64)/(64,1) のパラメータ数を Keras の式と比較する
```

別のターミナルに手で貼っても近いことはできる。違うのは 3 つ。

- **渡すのはこちらが書いたブリーフ 1 通。** 相手は毎回新しい子セッションなので、会話の履歴も捨てた案も
  届かない（相手にリポジトリの場所は教えない。何を止めているかは「使う前に知っておくこと」）。
  `explore` は自分の案が入ったリクエストを受け付けない
- **返答が相手ごとに同じ形式で届く。** 結論・指摘と根拠・足りなかった情報・判断が変わる条件・検証案・
  失敗の種類。複数に聞いても「おおむね一致」にまとめず、そのまま並べる。内容が正しいかどうかは
  サーバは何も言わない。確かめるのは主担当だ
- **確かめた結果が指摘の隣に残る。** 指摘ごとの id に verdict（確認できた／当てはまらない／確認不能／
  未確認）と判断への影響を書き戻し、`consult_export` でリポジトリに置ける Markdown にできる
  （実例: [docs/decisions/2026-09-11-concept-direction.md](docs/decisions/2026-09-11-concept-direction.md)）

3 つの CLI のどれからでも残りの 2 つに同じ形で聞けるよう作ってある（実運用の実績は Claude Code 起点のみ）。
何が返るかの実例と、手貼りや zen-mcp との違いは [docs/concept.md](docs/concept.md)、ツール API・隔離の
実装・設定・上限・既知の制約は [docs/reference.md](docs/reference.md)。

## しくみ

相談は毎回**専用の子セッション**として起動し（既存セッションには接続しない）、相手に渡るのはこちらが
書いたブリーフで、会話の履歴は渡らない。1 回の依頼で最大 3 者に**同一のブリーフ**を投げて 1 つの
`group_id` で受け取れるが、一致しているかどうかをサーバが判定することはない。相手に許すことと止めること
は「使う前に知っておくこと」にまとめた。

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
あるいは以下の状況で Skill が起動する。「みんなで相談して」「全員に聞いて」なら、2 者の相手と、自分と
同じ CLI の新しいセッションを合わせた 3 者に、同じブリーフが同時に飛ぶ（同じ系統の回答には注記が付く）。

- 重要な設計判断・巻き戻しにくい選択（アーキテクチャ、データ移行、並行性、セキュリティ）
- 選択肢が拮抗して自力で差がつかないとき
- 同じバグに2回以上失敗して新しい情報が出ていないとき

**小さな修正には使わない。** 1 回の相談で数分と実クォータを消費する。

**ふだんの相談は 3 手で終わる。** 相手は 1 者、mode は `review`、ブリーフは案を 1 段落と根拠になる事実を
数行、関係する diff かコードの抜粋を 1 つ。開始して、結果を取りに行き、判断を左右する検証を 1 つ実行して
から、確かめたこと・採用／不採用・まだ確かめていないことを報告する。実行した検証の結果は 1 回の
`consult_record` で指摘の隣に残る。それで上に挙げた形の答えが返る。

**後から問われる判断のとき**（インターフェース、移行、セキュリティ、並行性）は、Skill が段取りを足す。
問いと成功条件を整理し、外から課された制約と自分の仮定を分けて書き、相談前に予想を残し、返ってきた指摘を
確かめた結果を記録し、必要なら Markdown にしてリポジトリに置く。相談の開始は即座に返るので、主担当は
待つ間も別の作業を続けられる。

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

- 止めているのは、会話の履歴が渡ること、書き込み、ネットワーク（Web 検索と閲覧を除く）、MCP、さらなる相談。
  **読み取りは止めていない**。Codex の子セッションは read-only のシェルを持つので、書き込みはできないが
  ディスクは読める。Claude Code と Antigravity の子セッションはシェルも読み取りツールも持たない。どの相手も
  空の作業ディレクトリで起動するのでリポジトリの場所は知らず、見せたい物はブリーフに貼る。権限の内訳は
  [権限と隔離](docs/reference.md#権限と隔離)、詳細は [既知の制約](docs/reference.md#既知の制約)
- 相談相手が失敗した（`usage_limit` / `auth` / `timeout` …）ことと、答えたが根拠が薄いことは別物として
  返る。前者を「問題なしと言った」と読まない
- 履歴は `~/.peer-consult/history/` に残る。1 ラウンドにつき、送ったブリーフ・相手の回答・指摘ごとに
  主担当が書いた検証結果（`consult_record`）が 1 ファイルに揃い、`consult_export` で Markdown にして
  リポジトリに残せる。検証結果は後日、別のセッションから書き足せる。送信するブリーフと結果には
  資格情報のマスキングが掛かる
- 自分と同じ CLI の別モデルにも聞ける（Opus で作業中に Fable へ、`target: "claude:fable"`）。返答には
  「同じ系統」の注記が付く。`caller_model` で自分のモデルを申告すると、記録に「誰が誰に聞いたか」が残る
- 相談相手が「確かめよ」と返した項目のうち、主担当が実行できるのはコードの判断についての相談が主で、
  プロジェクト方針についての相談では他の人に依存する項目が返る。後者は未実行のまま人に渡る

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
| [docs/concept.md](docs/concept.md) | 実際の相談で見る使い方、手貼りや zen-mcp との違い、三者の役割、サーバが言うことと言わないこと、いつ使うか、限界 |
| [docs/decisions/](docs/decisions/) | 実際の相談 1 件の記録（ブリーフ・回答・指摘ごとの verdict） |
| [docs/reference.md](docs/reference.md) | 構成、ツール API、mode、結果の構造、失敗分類、権限と隔離、設計原則、設定、上限、検証結果、既知の制約 |
| [docs/experiments/](docs/experiments/) | 設計判断を実機で確かめた記録 |
| [docs/backlog.md](docs/backlog.md) | 方針と作業の一覧、作らないこと、未検証のこと、価値の測り方（案） |
