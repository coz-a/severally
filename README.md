# peer-consult

Codex と Claude Code が、互いに**独立した見解・レビュー・追加議論**を求めあうための MCP サーバと Skill。
両クライアントのプラグインとしてパッケージ済み（公開マーケットプレイス不要）。

相談は毎回**専用の子セッション**として起動する（既存セッションには接続しない）。相談相手には
**Web 検索・閲覧のみ**を許可し、ファイル変更・コマンド実行・さらなる相談は実行環境レベルで禁止する。

```
Claude Code ──(skill: peer-consult)──> mcp: peer-consult ──> codex exec   (gpt-6-astra)
Codex       ──(skill: peer-consult)──> mcp: peer-consult ──> claude -p    (claude-fable-5-1)
```

---

## 1. 構成

配布単位は `plugins/peer-consult/` の**プラグイン 1 つ**。Claude Code と Codex の両方のプラグイン形式を
同じディレクトリに同居させてある。

| 場所 | 内容 |
|---|---|
| `plugins/peer-consult/.claude-plugin/plugin.json` | Claude Code 用マニフェスト（`skills: ["./skills/claude"]`） |
| `plugins/peer-consult/.mcp.json` | Claude Code 用 MCP 定義（`${CLAUDE_PLUGIN_ROOT}/dist/...`） |
| `plugins/peer-consult/.codex-plugin/plugin.json` | Codex 用マニフェスト（skills と mcpServers を内包） |
| `plugins/peer-consult/skills/claude/peer-consult/` | Claude Code 用 Skill（→ Codex に相談する） |
| `plugins/peer-consult/skills/codex/peer-consult/` | Codex 用 Skill（→ Claude Code に相談する） |
| `plugins/peer-consult/dist/peer-consult-mcp.mjs` | 依存ゼロにバンドルした MCP サーバ（`npm run build` で生成、コミット済み） |
| `.agents/plugins/marketplace.json` | Codex 用のリポジトリローカル marketplace（公開レジストリではない） |
| `bin/`, `src/` | MCP サーバのソース（Node ESM、stdio） |
| `scripts/install.mjs` | インストール（プラグイン方式 / 手動方式） |
| `scripts/build.mjs` | esbuild でプラグイン内 `dist/` を生成 |
| `scripts/live-check.mjs`, `scripts/live-mcp-check.mjs` | 実 CLI・実 MCP での動作確認 |
| `test/` | オフライン検証（スタブ CLI による全分岐テスト） |

インストール先:

- Claude Code: `~/.claude/skills/peer-consult/`（skills-dir プラグインとして自動ロード。marketplace 不要）
- Codex: `~/.codex/plugins/cache/peer-consult-local/peer-consult/<version>/`（ローカル marketplace 経由）
- MCP バイナリ: `npm install -g` → `peer-consult-mcp`（**Codex 側は必須**。理由は §2.2）
- 実行時データ: `~/.peer-consult/`（履歴 `history/`、設定バックアップ `backups/`、権限 0700）

## 2. インストール

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
```

**クライアントは再起動が必要**（起動済みセッションはプラグインを読み直さない）。
プラグインを更新したら `npm run build && node scripts/install.mjs` を再実行する。

### 2.1 2 つの方式

| | プラグイン方式（既定） | 手動方式（`--manual`） |
|---|---|---|
| Claude Code | `~/.claude/skills/peer-consult/` にプラグインを配置（`peer-consult@skills-dir`） | `claude mcp add --scope user` ＋ Skill を単体コピー |
| Codex | リポジトリ内 marketplace から `codex plugin add` | `codex mcp add` ＋ Skill を単体コピー |
| MCP ツール名 | `mcp__plugin_peer-consult_peer-consult__*` | `mcp__peer-consult__*` |

インストーラは既存設定を保全する。クライアント設定は各 CLI（`plugin add` / `mcp add`）経由でのみ変更し、
`~/.claude.json`・`~/.codex/config.toml`・既存 Skill ディレクトリを `~/.peer-consult/backups/<timestamp>/`
（パス由来のユニークな名前）に退避してから作業する。方式を切り替えると、もう一方の方式で入った重複登録は
バックアップのうえ削除される。

公開マーケットプレイスへの登録は不要。Claude Code は marketplace なしで動き、Codex 用の
`.agents/plugins/marketplace.json` はこのリポジトリ内のローカルファイル。

### 2.2 なぜ Codex 側だけグローバルインストールが要るのか

Claude Code のプラグインは `${CLAUDE_PLUGIN_ROOT}` が `args` の中で展開されるので、同梱した
`dist/peer-consult-mcp.mjs` を直接起動でき、完全に自己完結する。

Codex 0.153.4 では**プラグイン自身のファイルを指す方法が実測で存在しなかった**。検証した結果:

| 書き方 | 結果 |
|---|---|
| `command: "bash", args: ["-c", ...]` | 起動する（プラグインの MCP 定義自体は機能している） |
| `command: "node", args: ["${PLUGIN_ROOT}/dist/..."]` | 起動するが `${PLUGIN_ROOT}` が**未展開のまま**渡る |
| `command: "./dist/peer-consult-mcp.mjs"`（`cwd` あり／なし） | 起動しない |
| `command: "node", args: ["./dist/..."], cwd: "${PLUGIN_ROOT}"` | 起動しない（`cwd` の変数も展開されない） |
| `command: "peer-consult-mcp"`（PATH 上の実行ファイル名） | **起動する** |

プラグインの MCP サーバに渡る環境変数に `PLUGIN_ROOT` は無く、既定の `cwd` はプラグイン root ではなく
セッションの作業ディレクトリだった。したがって Codex 側は「PATH 上のコマンド名」で参照するしかなく、
`npm install -g`（インストーラが実行する）が前提になる。Codex 側が `${PLUGIN_ROOT}` を展開するようになれば
マニフェストの 1 行を戻すだけで自己完結にできる。

## 3. 使い方

### 3.1 Skill 経由（通常）

「Codex に聞いて」「Claude にレビューしてもらって」「セカンドオピニオンが欲しい」といった依頼、
あるいは以下の状況で Skill が起動する。

- 重要な設計判断・巻き戻しにくい選択（アーキテクチャ、データ移行、並行性、セキュリティ）
- 選択肢が拮抗して自力で差がつかないとき
- 同じバグに2回以上失敗して新しい情報が出ていないとき

**小さな修正には使わない。** 1 回の相談で数分と実クォータを消費する。

Skill は「問いと成功条件の整理 → mode 選択 → 資料の添付 → 根拠の確認 → 重要な相違点だけ追加相談 →
採用／不採用／保留の整理」という進行を主担当（呼び出した側）に課す。

### 3.2 ツール API

```
consult_start({ request })  -> { job_id, chain_id, round, model, limits, ... }
consult_get({ job_id, wait_ms? }) -> 状態／結果（wait_ms で完了まで待てる。上限 45s ＝ MCP クライアント側の
                             リクエストタイムアウト 60s を下回るようにしてある。相談は 1〜5 分かかるので
                             通常は数回ポーリングする）
consult_cancel({ job_id })  -> 中断（相談相手のプロセスグループごと停止）
consult_list({ limit? })    -> 直近の相談一覧
```

`request`:

| フィールド | 必須 | 内容 |
|---|---|---|
| `target` | ✔ | `codex` / `claude-code` |
| `mode` | ✔ | `explore` / `review` / `debate` |
| `question` | ✔ | 決めたい問いを一文で |
| `objective` | ✔ | 何を達成したいか |
| `success_criteria` | – | 有用な回答の条件 |
| `constraints` | – | 変えられない前提（スタック、規模、期限） |
| `context.facts` | ※ | 確定している事実 |
| `context.proposal` | mode 依存 | 現在案と、その判断理由 |
| `context.counterpoints` | debate で必須 | 相手側の主張（相手の言い方で） |
| `context.artifacts` | ※ | 資料。`{name, kind, language?, source?, excerpt}`。`kind` は code / log / doc / data / diff / spec / test-output / config |
| `followup_to` | – | 初回 `null`、追加相談は先行ジョブの `job_id` |

※ `facts` か `artifacts` のどちらかは必須。**相談相手はローカルファイルを読めない**ので、
必要な本文は `artifacts.excerpt` に貼って渡す。

### 3.3 mode

| mode | 渡すもの | 得るもの |
|---|---|---|
| `explore` | 目的・制約・事実。**初回は推奨案を伏せる**（`proposal` を入れると拒否される） | 独立した案、別の問題設定、見落とし |
| `review` | 現在案と判断理由の要約 | 弱点、反例、改善案、成立条件 |
| `debate` | 争点・双方の主張・追加証拠 | 判断を変える条件、検証方法、残る不一致 |

`explore` の初回で `proposal` を渡すと `explore_proposal_not_allowed` で拒否する。アンカリングを避けるための仕様で、
案を批判してほしい場合は `review` を使う。

### 3.4 結果の構造

```
summary                 見解の要約
confidence              全体の確信度
evidence_basis          sufficient / thin / insufficient（相談相手の自己申告）
findings[]              point / grounds / impact / severity / confidence
alternatives[]          option / tradeoffs / when_preferred
unknowns[]              item / why_it_matters / how_to_obtain
decision_changers[]     condition / changes_to
next_checks[]           check / method / expected_signal
remaining_disagreements[] topic / your_position / why_unresolved
references[]            title / url / relevance
```

付随して `model`（実行モデル）、`duration_ms`、`usage`（取得できたトークン／コスト／Web 検索回数）、
`quality`（根拠のない指摘の数、出典の有無、注意書き）を記録する。**取得できない値は推測せず `null`。**
Codex CLI はコストを報告しないので `usage.cost_usd` は `null` になる。

### 3.5 未完了と「根拠不足の助言」の区別

`status` が `failed` / `cancelled` の場合は**助言が得られていない**。`failure.kind`:

| kind | 意味 | retriable |
|---|---|---|
| `timeout` | 制限時間内に終わらず停止 | ✔ |
| `cancelled` | `consult_cancel` またはサーバ終了 | – |
| `auth` | 未ログイン・認証拒否 | – |
| `usage_limit` | クォータ・レート制限 | – |
| `model_unavailable` | モデル名が拒否された／アクセス権なし | – |
| `invalid_output` | 実行はされたがスキーマに合う回答が出なかった | – |
| `cli_error` | その他の非ゼロ終了 | ✔ |
| `spawn_error` | CLI を起動できなかった | – |

これらを「相談相手は問題なしと言った」と要約してはいけない。
一方 `status: completed` でも `quality.evidence_basis` が `thin` / `insufficient` の場合は
「助言は届いたが根拠が薄い」であり、別物として扱う。

## 4. 権限と隔離

相談相手は毎回新しい子セッションとして起動し、親の設定・MCP・フックを継承しない。
ラッパーで権限解除フラグ（`--dangerously-*` 等）を渡すことは、コード側の禁止リストで拒否する。

| | Codex 子セッション | Claude Code 子セッション |
|---|---|---|
| モデル | `-m gpt-6-astra` | `--model claude-fable-5-1` |
| 編集・実行 | `-s read-only`（書き込み・ネットワーク遮断を実測確認） | `--restricted --tools WebSearch,WebFetch`（Read/Write/Edit/Bash なし） |
| 親 MCP の継承 | `--ignore-user-config`（`config.toml` を読まない＝再帰防止） | `--strict-mcp-config`（`--mcp-config` なし＝MCP ゼロ） |
| 親設定・フック | `--ignore-rules`, `hooks.enabled=false` | `--restricted`, `--setting-sources ''` |
| Skill | （下記の既知の制約を参照） | `--disable-slash-commands` |
| Web | `tools.web_search=true` | `WebSearch` / `WebFetch` |
| 作業ディレクトリ | ジョブ専用の空ディレクトリ（`-C`）。AGENTS.md / CLAUDE.md を拾わない | 同左（`cwd`） |
| セッション永続化 | `--ephemeral` | `--no-session-persistence` |
| 環境変数 | `CLAUDE_CODE_*` / `CLAUDECODE` / `MCP_*` / `PEER_CONSULT_*` と他社の認証情報を除去し、`PEER_CONSULT_ACTIVE=1` を付与 | 同左 |
| 承認プロンプト | なし（read-only 固定） | `--permission-prompts none`（プロンプトが必要な操作は自動拒否） |

再帰防止は三重: 子には MCP が存在しない／子環境の `PEER_CONSULT_ACTIVE=1` を見て `consult_start` を拒否する／
ブリーフに「他のエージェントに相談・委譲しない」と明記する。

認証情報は、送信するブリーフ・相談結果・ディスク上の履歴すべてに対して正規表現ベースのマスキング
（API キー、GitHub / Slack トークン、AWS キー、JWT、`Bearer`、PEM、`*_TOKEN=` 形式）を通す。

## 5. サーバ側の上限（リクエストからは変更不可）

`request` は strict スキーマで検証し、未知のフィールド（`model`, `sandbox`, `max_rounds` など）は
無視ではなく**拒否**する。上限はサーバプロセスの環境変数＝クライアント設定側でのみ変更できる。

| 環境変数 | 既定 | 範囲 |
|---|---|---|
| `PEER_CONSULT_CODEX_MODEL` | `gpt-6-astra` | – |
| `PEER_CONSULT_CLAUDE_MODEL` | `claude-fable-5-1` | – |
| `PEER_CONSULT_TIMEOUT_MS` | 600000 | 1000–1800000 |
| `PEER_CONSULT_MAX_ROUNDS` | 3（初回1＋追加2） | 1–5 |
| `PEER_CONSULT_MAX_CONCURRENT` | 2 | 1–4 |
| `PEER_CONSULT_CLAUDE_MAX_BUDGET_USD` | 2 | 0.05–20 |
| `PEER_CONSULT_MAX_WAIT_MS` | 45000 | 0–600000（60s 超は MCP クライアント側でタイムアウトする） |
| `PEER_CONSULT_HOME` | `~/.peer-consult` | – |

入力は 1 リクエスト 120,000 文字、artifact は 10 件・各 20,000 文字まで。出力側も要約 8,000 文字、
配列 30 件などで切り詰める。ジョブは自前のプロセスグループで起動し、キャンセル・タイムアウト・サーバ終了時は
**子孫プロセスごと** SIGTERM → SIGKILL する。

## 6. 検証

`npm test` は実 API を呼ばずにスタブ CLI で全分岐を確認する（39 件）。

- リクエスト検証：mode 別必須項目、explore の推奨案伏せ、未知フィールド拒否、サイズ上限
- 起動引数：制限フラグが付いていること、権限拡大フラグが付いていないこと（両方向）
- 子環境：`PEER_CONSULT_ACTIVE=1` の付与、親セッション変数の除去
- ブリーフ：資料の受け渡し、禁止事項の明記、explore 初回で案を渡さないこと
- 結果：構造化・マスキング・不正出力の失敗扱い・列挙値の非強制変換
- 失敗分類：`usage_limit` / `auth` / `model_unavailable` / `cli_error` / `timeout` / `invalid_output`
- 制御：ラウンド上限、同時実行上限、追加相談の対象・状態チェック、キャンセルと**孫プロセスの停止**、再帰拒否
- 履歴：ラウンド単位の永続化と作業ディレクトリの削除

実 CLI に対する確認は `scripts/live-check.mjs`（単一相談）と `scripts/live-mcp-check.mjs`
（インストール済み MCP サーバをクライアントとして駆動し、実相談 → 追加ラウンド → キャンセル → 履歴まで）で行う。

### 実測結果（2026-09-09）

| 項目 | 結果 |
|---|---|
| 実相談（Claude Code 方向、MCP 経由） | 完了。66.6s、$0.043、指摘5・代替案3・判断が変わる条件4・次の検証4・**残る不一致2 を保持** |
| 実相談（Claude Code 方向、sonnet-5・review） | 完了。242s、$0.400、指摘5（うち高2）。渡したコードの実バグ（`fetch` は 5xx で throw しない）を検出 |
| 追加ラウンド | round 2 が同一 chain に接続されることを実測 |
| キャンセル | 実行中の子 CLI プロセスが 1 → 0 になり、`status: cancelled` |
| タイムアウト | `PEER_CONSULT_TIMEOUT_MS=8000` で 8.55s に停止、`kind: timeout`、残留プロセスなし |
| 認証失敗 | 未認証の `CODEX_HOME` で実 codex を起動 → `kind: auth`（401、資格情報の露出なし） |
| クォータ上限 | 実 codex（`gpt-6-astra`）・実 claude（`claude-fable-5-1`）とも `kind: usage_limit` |
| 編集制限（Codex） | `codex sandbox` 実測：書き込み `Read-only file system`、ネットワーク `Could not resolve host` |
| 編集制限（Claude Code） | 子セッションに存在するツールは `WebFetch` / `WebSearch` のみ（本人に列挙させて確認） |
| 再帰防止（Codex） | peer-consult 登録済みの状態で、通常起動は MCP プロセスを 1 個起動、`--ignore-user-config` 付きは 0 個 |
| 再帰防止（Claude Code） | 子セッションのツール一覧に `peer`/`consult` を含む名前なし |
| 既存設定の保全 | `~/.codex/config.toml` の既存 MCP 2 件・trust 設定 19 件が維持され、バックアップを作成 |
| プラグイン（Claude Code） | `--plugin-dir` で読み込み、`mcp__plugin_peer-consult_peer-consult__*` の 4 ツールと Skill 1 件が出現。`claude plugin details` で Skills (1) / MCP servers (1)、常時コスト ~172 tok |
| プラグイン（Codex） | ローカル marketplace から `plugin add` → `installed, enabled`。MCP サーバが実際に起動することを、サーバ自身が作る `~/.peer-consult/` 相当のディレクトリで確認 |
| Skill の混線なし | Claude 側マニフェストは `skills/claude` のみを読み、`skills/codex` は読まない（`plugin details` の Skills (1)） |
| プラグイン経由の実相談 | インストール済みプラグインの `mcp__plugin_peer-consult_peer-consult__*` をエージェントに呼ばせ、実相談が `completed`／指摘 4 件で返ることを確認 |

Codex を**実行側**とする実相談（Codex が Claude Code に相談する往復）は、Codex アカウントが
2026-09-16 までクォータ上限のため未実施。Codex 側は「MCP 登録済み・サーバ接続可能・子セッション起動と
失敗分類まで実 CLI で到達」までを確認している。

## 7. 実案件での評価方法

導入の価値は「単独実行との差」でしか測れない。同種のタスクを相談あり／なしで比べ、以下を記録する。

1. **有効な新規指摘**：主担当が単独では出さず、検証して真だった指摘の件数。
   分母は `findings` 総数（採用率）。`grounds` が空の指摘は分子に数えない。
2. **誤指摘による手戻り**：採用したが検証で否定された指摘の件数と、それに費やした時間。
   これがプラス側を食う。`quality.caveat` が付いた回答での発生率を別に見る。
3. **検証による判断改善**：`next_checks` を実行して初期判断が変わった回数
   （変わらなかった場合も「確認できた」ことに価値があるので分けて数える）。
4. **追加コスト**：`duration_ms` の合計（相談中に主担当が並行作業できたかも記録）、
   `usage`（トークン、`cost_usd`、Web 検索回数）、消費ラウンド数。

判定の目安：**1 が 2 を上回り、4 が意思決定の巻き戻しコストより小さいとき**に使う価値がある。
`~/.peer-consult/history/index.jsonl` に 1 行 1 ラウンドで `status` / `failure_kind` / `duration_ms` が残るので、
これを分母にして集計する。合意の有無は指標にしない（合意は正しさの証拠ではない）。

## 8. 既知の制約

- **相談相手のモデルが現在クォータ上限**（2026-09-09 時点）。`gpt-6-astra` はアカウント全体で
  2026-09-16 まで、`claude-fable-5-1` は Fable 枠が上限に達している。両方向とも実 CLI まで到達して
  `failure.kind: "usage_limit"` に正しく分類されることは確認済み。実際の助言内容の往復は、
  `PEER_CONSULT_CLAUDE_MODEL=claude-sonnet-5` に切り替えた Claude Code 方向でのみ実測している（§ 検証結果）。
  クォータが戻れば設定変更なしで既定モデルのまま動く。なお Codex の最終応答は `-o` で書き出したファイルを
  第一候補に、取れない場合は `--json` イベントストリームから拾う二段構えにしてあるが、
  実 CLI で確認できているのは失敗経路のみで、成功経路はスタブ検証にとどまる。
- **Codex 子セッションはディスクを読める。** `-s read-only` は書き込みとネットワークを止めるが、
  読み取りは全ディスクに及ぶ（Codex 側に読み取り範囲を絞るオプションがない）。対策は
  空の作業ディレクトリ・「ローカルファイルを読むな」という明示・出力のマスキングで、
  シェル経由の持ち出しはネットワーク遮断により塞いでいるが、モデルが読んで応答に含める経路は
  マスキング頼りになる。機微なリポジトリで使う場合はこの前提を確認すること。
- **Codex 子セッションは `$CODEX_HOME/skills` を読む可能性がある**（`--ignore-user-config` が
  `config.toml` の読み込みを止めることは実測したが、skills ディレクトリの扱いは CLI 側の仕様が公開されていない）。
  読み込まれても MCP が無いため再帰はできず、シェルも read-only・ネットワーク遮断のため影響は指示テキストに留まる。
- Codex CLI は使用コストを報告しない（`usage.cost_usd` は `null`）。
- ジョブはサーバプロセスのメモリ上で管理される。クライアント再起動で `job_id` は失効する
  （完了済みの内容は `~/.peer-consult/history/` に残る）。
- MCP ツールのスキーマ検証は `request` オブジェクト単位で strict。トップレベルのタイプミスは
  「未知フィールド」として拒否される。

## 9. アンインストール

プラグイン方式:

```bash
rm -rf ~/.claude/skills/peer-consult                       # Claude Code
codex plugin remove peer-consult --marketplace peer-consult-local
codex plugin marketplace remove peer-consult-local
npm uninstall -g peer-consult-mcp
```

手動方式:

```bash
claude mcp remove peer-consult -s user
codex  mcp remove peer-consult
rm -rf ~/.claude/skills/peer-consult ~/.codex/skills/peer-consult
npm uninstall -g peer-consult-mcp
```

どちらも履歴とバックアップは `~/.peer-consult/` に残る（不要なら削除する）。
