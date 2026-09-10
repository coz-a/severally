# peer-consult

Codex、Claude Code、Antigravity (Gemini) が、互いに**独立した見解**を求めあうための MCP サーバと Skill。

## こんな経験はないだろうか

- 自分の案を見せて「どう思う?」と聞いたら、丁寧に**褒められて**終わった
- 2 つのモデルに聞いて「**だいたい同じ結論でした**」と言われたが、片方は根拠を一つも示していなかった
- レビューを頼んだら「**特に問題ありません**」と返ってきた。実際にはレート制限で一度も答えていなかった
- 自信のある**断定**が返ってきた。根拠を尋ねると、何も出てこなかった

どれも「役に立つ回答」の顔をしている。セカンドオピニオンで本当に怖いのは、**間違った答えが返ること**ではなく、
**独立していない答えが独立して見えること**だ。同意も、沈黙も、根拠のない断定も、外形は区別がつかない。

peer-consult は、その一点のために作られている。独立性は一度に失われるのではなく、気付かれずに少しずつ
削られる — こちらの案を見せた時点で、相手がこちらの文脈を読んだ時点で、ツールが「両者は概ね一致」と
要約した時点で。**壊れ方を一つずつ数え上げ、それぞれに対策を置いた**（→ §0）。

相談は毎回**専用の子セッション**として起動する（既存セッションには接続しない）。相談相手には
**Web 検索・閲覧のみ**を許可し、ファイル変更・コマンド実行・さらなる相談は実行環境レベルで禁止する。
1 回の依頼で最大 3 者に**同一のブリーフ**を投げて 1 つの `group_id` で受け取れるが、一致しているかどうかを
サーバが判定することはない。

Claude Code と Codex にはプラグインとしてパッケージ済み、Antigravity はインストーラが直接登録する
（いずれも公開マーケットプレイス不要。理由は §2）。

```
Claude Code ──(skill: peer-consult)──> mcp: peer-consult ──> codex exec | agy      (Codex / Antigravity)
Codex       ──(skill: peer-consult)──> mcp: peer-consult ──> claude -p  | agy      (Claude Code / Antigravity)
Antigravity ──(skill: peer-consult)──> mcp: peer-consult ──> codex exec | claude -p (Codex / Claude Code)
```

---

## 0. 独立性が壊れる経路と、その対策

冒頭の4つは、この表の最初の4行に対応する。機能表ではなく、この対応表がこのプロジェクトの中身である。

| 独立性が壊れる経路 | この実装の対策 |
|---|---|
| **自分の案を見せてから聞く**（アンカリング） | `explore` の初回は `context.proposal` を**拒否**する（`explore_proposal_not_allowed`）。案を批評させたいなら `review` を明示的に選ばせる |
| **ツールが合意を作る** | 複数に聞いても、サーバは一致・不一致を**判定しない**。機械的な横並びと「要約が似ていることは合意の証拠ではない」という注記だけを返す |
| **沈黙を「懸念なし」と読む** | 失敗を分類し（`usage_limit` / `auth` / `timeout` …）、「これは相談の結果ではない。相談相手は一度も答えていない」と返す。回答が薄いこと（`evidence_basis: thin`）とは別物として扱う |
| **主張を根拠と取り違える** | `findings` には `grounds` を要求し、欠けている件数を `quality.findings_without_grounds` に出す。参照がゼロなら「相手の推論だけで立っている」と注記する |
| **相手がこちらの文脈を読む** | 相談相手はローカルファイルを読めず、こちらのセッションも見えない。渡るのはブリーフだけ。毎回新しい子セッションで、既存セッションには接続しない |
| **相手が「作業」を始める** | 編集・シェル実行・MCP・さらなる相談を実行環境レベルで剥奪する。意見を貰う相手であって、作業させる相手ではない |
| **問いが相手ごとに違う** | 複数指名時は**バイト単位で同一のブリーフ**を全員に配る。少しずつ違う問いへの答えは比較できない |
| **同じ頭に二度聞く** | 呼び出し元と同じベンダーを指名した場合、「文脈をリセットした再読であって独立した意見ではない」と結果に明記する |
| **延々と往復する** | 1 回＋追加 2 回まで。追加相談は**食い違った点にだけ**使うよう skill が主担当に課す |
| **重い相談が何も残さず終わる** | 相談相手に「間に合わないなら `evidence_basis: thin` でその時点の答えを返せ」と指示し、実行中は `progress` で進行を見せ、時間切れ時は最後の痕跡を残す |

### 移譲の線をどこに引いたか

「何をツールに移譲し、何を呼び出し元に残すか」を、3つの問いで決めている。

1. **呼び出し元の都合で曲げられてはいけないか。** 主担当は締切に追われれば「今回だけ」と言い出す。その圧力に
   晒されない場所がツールである。権限の剥奪、再帰の禁止、ラウンド上限、秘密の除去、アンカリング拒否は
   すべてここ — skill の「お願い」として書いてあるだけなら、忙しいときに飛ばされる
2. **ツールの持つ情報だけで正しくできるか。** 統合、「この根拠で十分か」、「この相手はこの領域に強いか」は
   リポジトリ・経緯・意図を要する。必要な文脈がある場所で判断すべきで、ここではそれは呼び出し元である
3. **間違えたとき、呼び出し元は気付けるか。** 「両者は一致」と返されたら、本物の一致か作られた一致かは
   後から見分けられない。「メンバー2件、うち1件は `usage_limit` で失敗」なら、その場で検証できる。
   **気付けない誤りを生む主張を、ツールがしてはならない**

まとめると線はここに引かれる:

> ツールは、**自分の入力から機械的に導ける事実**までを主張してよい。**意味の解釈**を要するものを主張してはならない。

「このジョブは `usage_limit` で失敗した」「3件の findings に `grounds` が無い」「呼び出し元と同じベンダーだ」は
導ける。「この2つは同じことを言っている」は導けない。だから返すのは横並びまでで、一致の判定はしない。

逆に、移譲を減らせば安全というわけでもない。不変性が要るものを呼び出し元に任せれば、保証は最初に忙しく
なった日に消える。狙うのは**判断を代行せず、判断を安くする**こと — `comparison.by_target`、`grounds` の
欠落件数、`decision_changers`、`next_checks` は、結論を出さずに結論を出す作業を軽くするためにある。

### 何をしないか

- **合意形成をしない。** 複数の意見を統合したり、多数決を取ったり、収束させたりしない。食い違いは食い違いのまま返す。それを解釈するのは主担当の仕事であり、ツールが代行すると「無かった合意」が生まれる
- **作業を委譲しない。** 相談相手はコードを書かないし、ファイルも触らない。委譲したいなら別のツールの領分
- **決定を代行しない。** 返るのは判断材料（根拠・反例・見落とし・判断が変わる条件・次に確認すべきこと）であって、結論ではない

合意形成や多モデルの統合が欲しい場合は、[zen-mcp-server](https://github.com/BeehiveInnovations/zen-mcp-server)
のような「議論させて収束させる」設計のものが向いている（モデル数・ワークフローの広さでも、あちらが上である）。
違いは能力ではなく**移譲の線をどこに引いたか**で、そして線を狭く引くことは機能追加では得られない:
**収束させられるツールは、「合意を作らない」ことを同時に保証できない。** 保証とは「できないこと」で
定義されるからである。どちらが要るかは、相談を何に使うかによる。

---

## 1. 構成

配布単位は `plugins/peer-consult/` の**プラグイン 1 つ**。プラグイン形式を持つ 2 クライアント
（Claude Code と Codex）のマニフェストを同じディレクトリに同居させ、Antigravity は
**マニフェストを持たずインストーラが直接登録する**（`agy` にまだ検証済みのプラグインインストール経路がない。
理由は下記）。

| 場所 | 内容 |
|---|---|
| `plugins/peer-consult/.claude-plugin/plugin.json` | Claude Code 用マニフェスト（`skills: ["./skills/claude"]`） |
| `plugins/peer-consult/.mcp.json` | Claude Code 用 MCP 定義（`${CLAUDE_PLUGIN_ROOT}/dist/...`） |
| `plugins/peer-consult/.codex-plugin/plugin.json` | Codex 用マニフェスト（skills と mcpServers を内包） |
| `plugins/peer-consult/skills/claude/peer-consult/` | Claude Code 用 Skill（→ 他の2者に相談する） |
| `plugins/peer-consult/skills/codex/peer-consult/` | Codex 用 Skill（→ 他の2者に相談する） |
| `plugins/peer-consult/skills/antigravity/peer-consult/` | Antigravity 用 Skill（→ 他の2者に相談する） |
| `plugins/peer-consult/dist/peer-consult-mcp.mjs` | 依存ゼロにバンドルした MCP サーバ（`npm run build` で生成、コミット済み） |
| `.agents/plugins/marketplace.json` | Codex 用のリポジトリローカル marketplace（公開レジストリではない） |
| `bin/`, `src/` | MCP サーバのソース（Node ESM、stdio） |
| `scripts/install.mjs` | インストール（プラグイン方式 / 手動方式） |
| `config.example.json` | 環境ごとの設定の静的な例（§4.5） |
| `scripts/init-config.mjs` | その環境を検出して設定の雛形を生成（`npm run init-config`） |
| `scripts/build.mjs` | esbuild でプラグイン内 `dist/` を生成 |
| `scripts/live-check.mjs`, `scripts/live-mcp-check.mjs` | 実 CLI・実 MCP での動作確認 |
| `test/` | オフライン検証（スタブ CLI による全分岐テスト） |

**Antigravity にプラグイン形式のマニフェストを置いていない理由**（agy 1.1.28 実測）: `agy` は
プラグイン root 直下の `plugin.json` しか見ず、`.antigravity-plugin/` は読まない
（`agy plugin validate plugins/peer-consult` → `Error: missing plugin.json`）。root に置くと validate は
通るが、`skills : 4 processed`（マニフェストの `"skills"` を無視して共有 `skills/` ツリー全体を走査するため、
3 ホスト分の重複 skill と `_template` を読み込む）・`mcpServers : skipped (not found)` になり、実際には
機能しない。他の 2 クライアントが必要とする skills レイアウトを崩してまで合わせる価値が現時点でないため、
Antigravity は**両方式ともインストーラが直接登録する**（`agy mcp add` ＋ skill のコピー）。

インストール先:

- Claude Code: `~/.claude/skills/peer-consult/`（skills-dir プラグインとして自動ロード。marketplace 不要）
- Codex: `~/.codex/plugins/cache/peer-consult-local/peer-consult/<version>/`（ローカル marketplace 経由）
- Antigravity: `~/.gemini/config/skills/peer-consult/`（プラグイン方式・手動方式のどちらでも、インストーラが
  `agy mcp add` と skill のコピーで直接登録する）
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
agy    mcp list                      # peer-consult  stdio  enabled
```

**クライアントは再起動が必要**（起動済みセッションはプラグインを読み直さない）。
プラグインを更新したら `npm run build && node scripts/install.mjs` を再実行する。

### 2.1 2 つの方式

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
consult_start({ request })  -> 単一 target: { job_id, chain_id, round, model, limits, poll_with, ... }
                             targets（fan-out）: { group_id, jobs: [{job_id, chain_id, target, model}, ...],
                             poll_with: "consult_get({ group_id: ... })", ... } -- 全員が同一のブリーフを受け取る
consult_get({ job_id, wait_ms? }) -> 状態／結果（wait_ms で完了まで待てる。上限 45s ＝ MCP クライアント側の
                             リクエストタイムアウト 60s を下回るようにしてある。相談は 1〜5 分かかるので
                             通常は数回ポーリングする）
                             実行中は `progress` に相談相手の進行状況（`8 item event(s), last was web_search` など。
                             イベントを流す Codex / Antigravity のみ）。重い相談だと分かった時点で
                             `consult_cancel` して問いを絞り直せる
consult_get({ group_id, wait_ms? }) -> fan-out の状態／結果を1回でまとめて取得。`members`（各 target の状態・結果）、
                             `comparison.by_target`（機械的な横並び。サーバは一致しているかどうかを判定しない）、
                             履歴が刈られて一部メンバーが失われた場合の `members_expected` / `members_available` /
                             `incomplete_note`、次に何をすべきかの `next_step` を含む
consult_cancel({ job_id })  -> 中断（相談相手のプロセスグループごと停止）
consult_cancel({ group_id }) -> fan-out 全員を中断
consult_list({ limit? })    -> 直近の相談一覧
```

`request`:

| フィールド | 必須 | 内容 |
|---|---|---|
| `target` | いずれか一方 | `codex` / `claude-code` / `antigravity`（エイリアス: gpt, chatgpt, openai / claude, anthropic / gemini, agy, google。大小文字・空白は無視）。`<target>:<model>` の形でモデルを指定できる（例: `claude:claude-opus-5`）|
| `targets` | いずれか一方 | `target` と排他。1〜3件、重複不可（モデル指定の有無に関わらずターゲットで判定）。各要素が `<target>[:<model>]`。同一ブリーフを全員に同時送信し、1つの `group_id` にまとまる |
| `caller` | – | 呼び出し元 CLI（同じ表記が使える）。`target`/`targets` と同じベンダーだと `quality.caveat` に「独立した意見ではなくフレッシュコンテキストでの再チェック」と注記される |
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

**モデルの指定**（`<target>:<model>`）は、ユーザーが名指ししたときだけ使う。指定できるのは運用者が
`PEER_CONSULT_<TARGET>_ALLOWED_MODELS` で許可したモデルだけで、既定モデルは常に許可される。書き方は緩く、
大小文字・空白を無視したうえで許可リストに**一意に**部分一致すればよい（`claude:opus` → `claude-opus-5`）。
許可外は起動前に `model_not_allowed`、2つに該当する場合は候補を挙げて `model_ambiguous` として拒否し、
黙って一方を選ぶことはしない。現在許可されているモデルは `consult_start` のツール説明文に列挙される。

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

| | Codex 子セッション | Claude Code 子セッション | Antigravity 子セッション |
|---|---|---|---|
| モデル | `-m gpt-6-astra` | `--model claude-fable-5-1` | `--model gemini-3.8-flash-high`（effort はモデル名に内包。`--effort` は渡さない） |
| 編集・実行 | `-s read-only`（書き込み・ネットワーク遮断を実測確認） | `--restricted --tools WebSearch,WebFetch`（Read/Write/Edit/Bash なし） | 合成 HOME の `settings.json` で `permissions.deny` に `write_file(*)` / `read_file(*)` / `command(*)` / `mcp(*)` / `execute_url(*)` / `unsandboxed(*)`、`permissions.allow` に `read_url(*)` のみ |
| 親 MCP の継承 | `--ignore-user-config`（`config.toml` を読まない＝再帰防止） | `--strict-mcp-config`（`--mcp-config` なし＝MCP ゼロ） | 二重の防止: 合成 HOME 内の `.gemini/config/mcp_config.json` が空 `{}`（MCP サーバ 0 件）に加え、`permissions.deny` にも `mcp(*)` が明示されている |
| 親設定・フック | `--ignore-rules`, `hooks.enabled=false` | `--restricted`, `--setting-sources ''` | 合成 HOME には `hooks.json` / `skills/` / `plugins/` / `projects/` 一切なし。実 `$HOME` の `~/.gemini` を継承しない |
| Skill | （下記の既知の制約を参照） | `--disable-slash-commands` | `--disable-slash-commands`（合成 HOME に skills も存在しない） |
| Web | `tools.web_search=true` | `WebSearch` / `WebFetch` | `search_web`（無条件で許可）／`read_url`（`permissions.allow` で明示許可しないと閲覧できない） |
| 作業ディレクトリ | ジョブ専用の空ディレクトリ（`-C`）。AGENTS.md / CLAUDE.md を拾わない | 同左（`cwd`） | 同左（`cwd`）。ブリーフは argv でなく stdin から渡す |
| セッション永続化 | `--ephemeral` | `--no-session-persistence` | agy に同等フラグはないため、ジョブ専用の合成 HOME（`<jobdir>/home`, mode 0700）に会話状態を書かせ、ジョブ終了時にそのツリーごと削除する |
| 資格情報 | 実行ユーザの Codex 認証情報を継承 | 実行ユーザの Claude 認証情報を継承 | 実 `$HOME`（既定。`PEER_CONSULT_AGY_CRED_HOME` で変更可）のトークンを合成 HOME に symlink（symlink 不可な FS ではコピー）。トークンと API キー（`GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`）は**択一**で、**両方とも無い場合のみ子プロセスを起動せず**、探索したパスと API キー変数名を明記して `kind: auth` で失敗する（実 CLI で検証済みなのはトークン経路のみ） |
| 環境変数 | `CLAUDE_CODE_*` / `CLAUDECODE` / `MCP_*` / `PEER_CONSULT_*` と他社の認証情報を除去し、`PEER_CONSULT_ACTIVE=1` を付与。さらに `-c shell_environment_policy.set={PEER_CONSULT_ACTIVE="1"}` で子シェル側にも同じマーカーを渡す（`inherit="none"` が親環境ごと落とすため） | 同左（マーカーはプロセス環境のみ） | 同左に加えて `XDG_CONFIG_HOME` / `AGY_*` / `ANTIGRAVITY_*` も除去（設定ツリーを別の場所に向けうる変数を残さない）。`GEMINI_*` / `GOOGLE_*` は API キー・ADC 認証の経路なので残す |
| 承認プロンプト | なし（read-only 固定） | `--permission-prompts none`（プロンプトが必要な操作は自動拒否） | なし（ヘッドレスモードはプロンプトが要る操作を自動拒否し、deny ルールが優先される） |

再帰防止は三重: 子には MCP が存在しない／子環境の `PEER_CONSULT_ACTIVE=1` を見て `consult_start` を拒否する／
ブリーフに「他のエージェントに相談・委譲しない」と明記する。Codex は `shell_environment_policy.inherit="none"`
により子シェルが親環境を一切受け取らないので、マーカーが子シェルに届くよう
`shell_environment_policy.set` で明示的に注入している（codex 0.153.4 で
`codex sandbox -c 'shell_environment_policy.inherit="none"' -c 'shell_environment_policy.set={PEER_CONSULT_ACTIVE="1"}' -- env`
が `PEER_CONSULT_ACTIVE=1` のみを出すことを実測）。サブエージェント経由の書き込み試行も、同じ
`permissions.deny` に阻まれることを実機（agy 1.1.28）で確認済み。

認証情報は、送信するブリーフ・相談結果・ディスク上の履歴すべてに対して正規表現ベースのマスキング
（API キー、GitHub / Slack トークン、AWS キー、JWT、`Bearer`、PEM、`*_TOKEN=` 形式）を通す。

## 4.5 環境ごとの設定（1 ファイル）

codex が無い環境、agy が無い環境がある。**既定では設定不要**で、サーバは起動時に各 CLI が PATH に
あるかを見て、無い相手を候補から外す。使えない相手を指名した相談は、ジョブを作る前に
`target_unavailable`（使える相手を列挙）として拒否される。`consult_start` の説明文と
`limits.available_targets` にも、その環境で実際に使える相手だけが載る。

明示的に制御したい場合は `~/.peer-consult/config.json`（`PEER_CONSULT_CONFIG` で変更可）を 1 つ置く。
クライアントごとの MCP 登録に env を書き分ける必要はない。雛形はその環境向けに生成できる:

```bash
npm run init-config            # ~/.peer-consult/config.json を生成（既存は上書きしない）
node scripts/init-config.mjs --print   # 書かずに標準出力へ
node scripts/init-config.mjs --force   # 既存を置き換える
```

設定ファイルは **JSONC**（コメントと末尾カンマを許す JSON）として読む。素の JSON も当然そのまま通る。
生成される雛形は説明をコメントで持ち、データ側は空のまま:

```jsonc
{
  // peer-consult configuration. Comments and trailing commas are allowed.
  //   enabled          false to exclude a consultant whose CLI is installed
  //   default_model    the model it runs unless a request names another
  //   allowed_models   the models a request MAY name
  //   timeout_ms       this consultant's own budget in ms
  //   ...
  "targets": {
    // codex found, default model gpt-6-astra
    "codex": {},
  }
}
```

ファイル名は `config.json` でよいが、エディタが `.json` 内のコメントをエラー扱いする場合は
`config.jsonc` でも読む（両方あれば `.jsonc` が優先）。どの CLI が検出されたかは生成コマンドの標準出力に
出る（起動のたびに再検出される事実なので、ファイルには焼かない）。

```json
{
  "targets": {
    "codex":       { "enabled": false },
    "claude-code": { "models": ["claude-opus-5", "claude-sonnet-5"] },
    "antigravity": { "bin": "/opt/agy/bin/agy" }
  }
}
```

| キー | 意味 |
|---|---|
| `enabled` | 省略時は自動検出（CLI が PATH にあるか）。**CLI は入っているがレート制限などで使いたくない場合は `false`** |
| `note` | 使えない理由。相談を拒否するときに呼び出し側へそのまま返る（例: `"rate-limited until 15:00"`）|
| `bin` | 実行ファイル名またはパス。ラッパースクリプトを噛ませたい場合はここ（絶対パス推奨。MCP サーバは対話シェルと PATH が同じとは限らない）。先頭の `~/` は展開する |
| `default_model` | その相談相手が既定で使うモデル |
| `allowed_models` | リクエストが**指名してよい**モデル。`default_model` は常に許可されるので、追加分だけ書く |
| `timeout_ms` | この相談相手だけの制限時間（ms）。未指定なら共通値。上限 30 分 |

時間切れ対策は3段構えになっている: ブリーフの guardrails が相談相手に「間に合わないと判断したら、その時点の
答えを `evidence_basis: thin` で返し、確認できなかったことを `unknowns` / `next_checks` に書け」と指示する
（全損を薄い回答に変える）。実行中は `consult_get` の `progress` で進行が見えるので、待ち切る前に打ち切れる。
時間切れになった場合は `failure.detail` に最後の痕跡が残り、「予算不足」か「ブリーフが重すぎた」かを切り分けられる。

**優先順位は env > 設定ファイル > 自動検出 > 既定値**（knob 単位）。`PEER_CONSULT_TARGETS=codex,claude-code`
のように env で有効な相手を列挙した場合は、それが唯一の集合になる（設定ファイルの `enabled` より優先）。

設定ファイルは**サーバ起動時に 1 度だけ**読む。あとから CLI を入れた場合や設定を変えた場合はクライアントの
再起動が必要。壊れた JSON は黙って無視せず、起動時に stderr へ理由を出したうえで既定値で動く。

## 5. サーバ側の上限（リクエストからは変更不可）

`request` は strict スキーマで検証し、未知のフィールド（`model`, `sandbox`, `max_rounds` など）は
無視ではなく**拒否**する。上限はサーバプロセスの環境変数＝クライアント設定側でのみ変更できる。

| 環境変数 | 既定 | 範囲 |
|---|---|---|
| `PEER_CONSULT_CODEX_BIN` | `codex` | – |
| `PEER_CONSULT_CODEX_MODEL` | `gpt-6-astra` | – |
| `PEER_CONSULT_CODEX_ALLOWED_MODELS` | –（既定モデルのみ） | リクエストで指定を許すモデルをカンマ区切りで追加 |
| `PEER_CONSULT_CODEX_EFFORT` | `medium` | – |
| `PEER_CONSULT_CLAUDE_BIN` | `claude` | – |
| `PEER_CONSULT_CLAUDE_MODEL` | `claude-fable-5-1` | – |
| `PEER_CONSULT_CLAUDE_ALLOWED_MODELS` | –（既定モデルのみ） | 同上（例: `claude-opus-5,claude-sonnet-5`）|
| `PEER_CONSULT_AGY_BIN` | `agy` | – |
| `PEER_CONSULT_AGY_MODEL` | `gemini-3.8-flash-high`（reasoning effort込みのモデル名。`--effort` は渡さない） | – |
| `PEER_CONSULT_AGY_ALLOWED_MODELS` | –（既定モデルのみ） | 同上 |
| `PEER_CONSULT_AGY_CRED_HOME` | 実行ユーザの `$HOME`（合成 HOME に symlink するトークンの取得元） | – |
| `PEER_CONSULT_TIMEOUT_MS` | 600000 | 1000–1800000 |
| `PEER_CONSULT_CODEX_TIMEOUT_MS` / `_CLAUDE_` / `_AGY_` | 共通値 | 相談相手ごとの制限時間。Gemini は込み入った依頼で 10 分を超えることがある |
| `PEER_CONSULT_MAX_ROUNDS` | 3（初回1＋追加2） | 1–5 |
| `PEER_CONSULT_MAX_CONCURRENT` | 3（fan-out は N 消費） | 1–4 |
| `PEER_CONSULT_MAX_JOBS_RETAINED` | 200（メモリ上に保持するジョブ数。超えると古い方から破棄され、`job_id` / `group_id` で参照できなくなる） | 20–2000 |
| `PEER_CONSULT_CLAUDE_MAX_BUDGET_USD` | 2 | 0.05–20 |
| `PEER_CONSULT_MAX_WAIT_MS` | 45000 | 0–600000（60s 超は MCP クライアント側でタイムアウトする） |
| `PEER_CONSULT_KILL_GRACE_MS` | 5000 | 500–60000（SIGTERM から SIGKILL までの猶予） |
| `PEER_CONSULT_HOME` | `~/.peer-consult` | – |

`*_BIN` は PATH 上のコマンド名か絶対パス。`npm test` はこれらをスタブ CLI に差し替えて実行する。

入力は 1 リクエスト 120,000 文字、artifact は 10 件・各 20,000 文字まで。出力側も要約 8,000 文字、
配列 30 件などで切り詰める。ジョブは自前のプロセスグループで起動し、キャンセル・タイムアウト・サーバ終了時は
**子孫プロセスごと** SIGTERM → SIGKILL する。

## 6. 検証

`npm test` は実 API を呼ばずにスタブ CLI で全分岐を確認するオフライン検証一式。件数は変わり続けるので
`npm test` の出力自体（`ℹ tests N` / `ℹ pass N`）を数の正とする。

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

### 実測結果（2026-09-09、Antigravity 分は 2026-09-10）

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
| 実相談（Antigravity 方向、`gemini-3.8-flash-high`・review）<br>2026-09-10 | 完了。105.1s、`evidence_basis: sufficient`、`references` 2 件（Google SRE Book / AWS Builders' Library）、`usage.denied_actions: null`、`findings_without_grounds: 0`。子環境を絞ったあとの実行なので、**symlink したトークンで認証が通ること**の確認になる。ただしこの実行時のシェルには `XDG_CONFIG_HOME` / `AGY_*` / `ANTIGRAVITY_*` がそもそも設定されていなかったため、除去そのものは実相談では検証していない（除去はオフラインテストで確認） |
| 編集制限（Antigravity、サブエージェント経由）<br>2026-09-10 | 子セッションにサブエージェント経由でファイル作成を指示 → `sub.txt` は作成されず、エンベロープが `write_file` の deny を報告。合成 HOME の `permissions.deny` がサブエージェント側にも適用されることを確認 |
| プラグイン形式（Antigravity）<br>2026-09-10 | `agy plugin validate plugins/peer-consult` は `.antigravity-plugin/` を読まず `Error: missing plugin.json`。root に置くと validate は通るが `skills : 4 processed`（マニフェストの `"skills"` を無視）・`mcpServers : skipped (not found)`。ゆえにマニフェストは同梱せず、インストーラが直接登録する |

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
- **Antigravity 子セッションの隔離は `HOME` 1 本に依存する。** Codex（`--ignore-user-config`）や
  Claude Code（`--restricted --strict-mcp-config`）と違い、agy には環境変数で無効化できない隔離フラグがない。
  設定・MCP・skills・権限はすべて `~/.gemini` 由来なので、合成 HOME を別の設定ツリーに向けられれば
  空の `mcp_config.json` と deny ルールをすり抜けたまま相談が成功しうる。対策として `XDG_CONFIG_HOME` /
  `AGY_*` / `ANTIGRAVITY_*` を子環境から除去している。agy 1.1.28 での実測では `agy mcp list` は `HOME` にのみ
  従い `XDG_CONFIG_HOME` を無視した（両方向で確認）。`AGY_*` については、バイナリ内の文字列に設定ディレクトリを
  指す名前が見つからなかった＝**「見つからなかった」までしか言えない**（総当たりの証明ではない）。
  `GEMINI_*` / `GOOGLE_*` は API キー・ADC 認証の経路なので意図的に残している。
- **合成 HOME 内で更新されたトークンが実 `$HOME` に書き戻るかは未検証。** トークンは symlink で渡しているので
  原理上は実ファイルが更新されるが、agy が in-place 更新するのか一時ファイル + rename（symlink を置き換える）
  なのかは確認していない。後者ならリフレッシュはジョブ終了時に破棄される。
- **agy にはプラグインインストール経路がない**（`agy plugin validate` は `.antigravity-plugin/` を読まず、
  root に置いても `mcpServers` を無視する。§6 参照）。インストーラが `agy mcp add` と skill のコピーで
  直接登録するため機能上の欠落はないが、他の 2 クライアントのようにマニフェスト 1 つで完結はしない。
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
