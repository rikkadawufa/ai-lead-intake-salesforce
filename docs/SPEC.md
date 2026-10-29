# 實作規格：AI Lead Intake → Salesforce（n8n + OpenAI）

> 方向與理由見 `../../00-作品集方向_繁中.md`。本檔是可直接執行的規格，沿用 HubSpot 版（`2026-10-28_n8n-lead-intake-hubspot/demo/docs/SPEC.md`）的結構，只寫**不一樣的地方**和完整的驗收清單。遇到跟實際 API 不符的地方：在 `docs/VERIFICATION.md` 記下來，選最小的改動保住原意。
> 程式碼、註解、README、commit message 用英文；`docs/VERIFICATION.md` 用繁體中文。

---

## 0. 前置條件（使用者完成，見 `../../01-帳號準備步驟_繁中.md`）
- `demo/.env` 已填：`SF_INSTANCE_URL`（My Domain）、`SF_CLIENT_ID`、`SF_CLIENT_SECRET`，以及沿用 HubSpot 版的 `GMAIL_ADDRESS`、`GMAIL_APP_PASSWORD`、`SLACK_WEBHOOK_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`REPLY_REDIRECT_TO`。
- Docker Desktop 執行中；n8n 在 http://localhost:5680 （compose 專案名 `lead-intake-sf-demo`，和 HubSpot 版的 volume 分開）。
- 缺值時只做離線部分，VERIFICATION.md 記下哪些沒測。

## 1. 硬性規則（和 HubSpot 版相同，CRM 換掉）
1. 不安裝套件：Python 只用標準函式庫；Node 只用內建模組。
2. 機密不印、不寫 log、不進 git；錯誤訊息裡的 token、secret 換成 `***`。
3. 不建付費資源；Salesforce 維持 Developer Edition。
4. 不 git push、不建 GitHub repo。
5. 開發一律 `LLM_MODE=mock`；live 只在 §9.3，每一輪都要先經使用者同意，最多 3 輪。
6. **Salesforce 寫入範圍**：只碰 email 結尾是 `@example.com`／`@example.org` 的 Lead、Contact（或沒有 email、電話在虛構的 555-0100–0199 範圍），和掛在它們底下的 Task；reset 只刪這些，加上 §8.2 列名的 demo Account。demo 模式下，只有電話的詢問也只接受這個範圍。
7. 寄信：`DEMO_MODE=1` 時一律寄到 `REPLY_REDIRECT_TO`，主旨加 `[demo → <原收件人>]`。

## 2. 檔案結構（和 HubSpot 版的差異）
- `scripts/salesforce_client.py` 取代 `hubspot_client.py`：client credentials 換 token、REST／Tooling 請求、SOQL 分頁、重試、遮罩。
- `scripts/salesforce_setup.py` 取代 `hubspot_setup.py`：建自訂欄位、permission set 與指派、T9 的 demo Contact。
- `scripts/compare_results.py`（新）：HubSpot／Salesforce 並排表。
- `results/hubspot-live-round-2.json`（新）：HubSpot 版 live 第 2 輪結果的副本，demo 收件匣地址換成 `demo inbox`。
- `n8n-src/code/match.js` 取代 `contact.js`；`records.js` 的 note 換成 Task。
- `docs/FIELD-MAPPING.md`（新）：欄位對應表。

## 3. 資料格式
### 3.1 Inquiry：和 HubSpot 版相同（`normalize.js` 不改邏輯）。

### 3.2 Salesforce 自訂欄位（`salesforce_setup.py` 用 Tooling API 建，已存在就略過）
| 物件 | API name | 型別 | 值 |
|---|---|---|---|
| Lead、Contact | `Lead_Tier__c` | Picklist（restricted） | `qualified`／`needs_review`／`not_qualified` |
| Lead、Contact | `Inquiry_Topic__c` | Picklist（restricted） | 同 HubSpot 版 7 個 |
| Lead、Contact | `Inquiry_Urgency__c` | Picklist（restricted） | `high`／`normal`／`low` |
| Lead、Contact | `Inquiry_Source__c` | Picklist（restricted） | `form`／`email`（最近一次） |
| Lead、Contact | `AI_Reason__c` | Long Text Area 32768 | 理由＋`Quote: "…"` |
| Lead、Contact | `Phone_E164__c` | Text(16) | 寫入時的 E.164 電話，比對用 |
| Task（Activity） | `Inquiry_Source_ID__c` | Text(255)，External ID＋Unique＋區分大小寫（2026-10-30 實測 Developer Edition 接受） | `form:…`／`email:<Message-ID>` |

- Activity 的自訂欄位若不允許 Unique／External ID，退回一般 Text 欄位，VERIFICATION 記下。去重靠 §4 的查詢，不靠這個限制；對外不宣稱「同時送進來也擋得住」，除非 Unique 真的建成並測過。
- **欄位權限**：建一個 permission set `Lead_Intake_Demo`，對上面每個欄位給 Read＋Edit，指派給 Run As 使用者（`/services/oauth2/userinfo` 取 user id）。
- Lead→Contact 的欄位對應（轉換時帶過去）不自動化，`docs/SETUP.md` 寫成選做的 UI 步驟。

### 3.3 Lead 必填與預設
- `LastName`：姓名拆出來的姓；沒有名字時用 email `@` 前面那段；都沒有用 `(unknown)`。
- `Company`：有就填，沒有填 `[not provided]`。之後的詢問帶了公司名，就補上（只在現值是空的或 `[not provided]` 時）。
- `LeadSource`：表單 `Web`；email 不設。
- `Phone`、`Phone_E164__c`：E.164。

## 4. 比對、去重與冪等
1. **一次 Composite 請求**（`POST /services/data/{v}/composite`，`allOrNone:false`）查這些（沒有 email 或電話就略過對應的子請求）：
   - `dupTask`：`SELECT Id, WhoId FROM Task WHERE Inquiry_Source_ID__c = '<source_id>' LIMIT 1`
   - `contactEmail`、`leadEmail`：`Email = '<email>'`；Lead 加 `IsConverted = false`
   - `contactPhone`、`leadPhone`：`Phone_E164__c = '<E.164>'`
   - SOQL 字串一律跳脫 `\` 和 `'`；任何子請求失敗（例如欄位不存在）就丟錯，讓 error workflow 告警，不默默當成「沒找到」。
2. 優先順序：`contactEmail` → `leadEmail` → `contactPhone` → `leadPhone`（Contact 先於 Lead）。
2.5 都沒找到、不是重送、又有電話時，**另外**呼叫一次 SOSL `FIND {<10 碼>} IN PHONE FIELDS RETURNING Contact(…), Lead(… WHERE IsConverted = false)`，補查人手輸入、格式不同的電話。Composite 不接受 `/search` 子請求（實測 404），所以不能放進第 1 步。SOSL 不接受 `+` 和 `-`，只送數字。新記錄要幾分鐘後才搜得到。
3. `dupTask` 有結果 → 整筆停止，run log 記 `duplicate_submission`（`record_id` = 那筆 Task 的 WhoId），不分級、不建 Task、不產草稿。
4. 找到 Contact → 更新 Contact；找到 Lead → 更新 Lead；都沒有 → 建 Lead。**永遠不自動建 Contact、不轉換 Lead。**
5. 建 Lead 回 `DUPLICATES_DETECTED`（Salesforce 的 duplicate rule 擋下）→ 從 `duplicateResult.matchResults` 取第一筆既有記錄的 id 和類型 → 讀它的現值 → 改走更新。其他錯誤照樣丟錯。
6. 更新規則同 HubSpot 版：tier 已是 qualified 不降級；其他 AI 欄位以最新一筆為準；身分欄位（FirstName、Email、Phone、Company）只補空的。
7. 每筆詢問都建一筆 Task 掛在該 Lead／Contact（`WhoId`）：`Subject` = `Inquiry via <source>: <subject 或訊息前 60 字>`（≤255）、`Description` = 收到時間＋主旨＋原文＋`AI: tier / topic / urgency — reason`、`Status` = `Completed`、`ActivityDate` = 收到日期、`Inquiry_Source_ID__c` = source_id。
8. 記錄連結：`<SF_INSTANCE_URL>/lightning/r/<Lead|Contact>/<id>/view`。

## 5. LLM：和 HubSpot 版完全相同（prompt、schema、模型、檢查、失敗處理、mock）。

## 6. 人工核准：和 HubSpot 版相同，只改文字
- 審核頁連結文字 `Open record in Salesforce`；說明 `Your name is saved on the Salesforce record with the decision.`
- 決定寫成一筆 Task（沒有 `Inquiry_Source_ID__c`）：`Subject` = `AI reply approved by <reviewer>`／`AI reply rejected by <reviewer>`／`AI reply review timed out`，`Description` 同 HubSpot 版 note 的文字（含寄出的主旨與內文）。

## 7. n8n 環境
- 映像 `2.44.7`、port 5680、`WEBHOOK_URL=http://localhost:5680/`。
- Credentials（`n8n_setup.py` 匯入，固定 id）：
  - `salesforceOAuthCred01`：`oAuth2Api`，grantType `clientCredentials`，accessTokenUrl `<SF_INSTANCE_URL>/services/oauth2/token`，authentication `body`。n8n 第一次用時自己換 token，401 時重換。
  - `openAiCred01`、`gmailImapCred01`、`gmailSmtpCred01`：同 HubSpot 版。
- 非機密環境變數：`SF_INSTANCE_URL`、`SF_API_VERSION`（預設 `v63.0`，setup 時確認 org 支援）。

## 8. Workflows 與腳本
### 8.1 Workflows（`build-workflows.mjs` 產生 5 個，名稱沿用）
- WF1 `wfFormIntake`、WF2 `wfEmailIntake`、WF5 `wfReviewPage`、WF4 `wfErrorHandler`：同 HubSpot 版，只換文字和 port。
- WF3 `wfProcessInquiry`：Start → Build lookup → **Salesforce lookup（Composite）** → Resolve match →（沒找到且有電話）Phone search → 重複就停 → qualify → Existing record? → Update record（PATCH）或 Create lead（→ duplicate rule 命中就讀既有記錄再更新）→ Create inquiry task → 草稿 → 審核 → 寄或不寄 → Create decision task → run log。
- run log 欄位：`{source_id, fixture_id, record_type, record_id, matched_by, action: created|updated|duplicate_submission|rejected_input, tier, llm_ok, llm_error, draft, reviewer, edited, sent_to, alerts[]}`。

### 8.2 腳本
- `salesforce_setup.py`：確認 API 版本 → 建缺的欄位 → permission set＋欄位權限＋指派 → 建 T9 用的 demo Account `Brookside Veterinary (demo)` 和 Contact `Avery Brooks <avery.brooks@example.com>`（已存在就略過）。`--dry-run` 只列出要做的事。
- `reset_demo.py`：預設 dry run；`--apply` 刪 demo Lead／Contact 和它們的 Task、demo Account，清本機 output，**再重建 T9 的 demo Contact**。
- `collect_results.py`：讀 run log＋Salesforce＋demo 收件匣 → `output/results.md／json`。T1–T8 計入「N / 8」；T9 另列。
- `compare_results.py`：`results/hubspot-live-round-2.json` 和 `output/results.json` → `output/results-side-by-side.md`。

## 9. 驗收清單（結果寫進 `docs/VERIFICATION.md`，每項標 PASS／FAIL／NOT RUN）
### 9.1 離線
- O1 `node --test "n8n-src/code/*.test.js" "n8n-src/*.test.mjs"` 全過；包含 match.js：SOQL 跳脫、composite 組裝（有／沒有 email、電話）、比對優先順序、Task 重複、子請求失敗會丟錯、DUPLICATES_DETECTED 解析、Lead 必填預設、只補空欄位、tier 不降級
- O2 `python -m unittest discover tests_scripts` 全過：client 換 token、重試、遮罩、SOQL 分頁；setup 只建缺的、欄位權限；reset 只刪 demo 網域；結果判斷；並排表
- O3 `node n8n-src/build-workflows.mjs` 產生 5 個 JSON，兩次輸出相同；workflow 裡沒有任何 HubSpot 字樣、沒有機密
- O4 `send_fixtures.py --dry-run` 印出 T1–T9 要送的內容，不含機密

### 9.2 n8n 本機（mock LLM，真的 Salesforce／Gmail／Slack）
- N1 `salesforce_setup.py` 建好 13 個欄位、permission set、demo Contact；再跑一次全部略過
- N2 n8n credential 用 client credentials 拿得到 token（一個查詢節點成功）
- N3 `reset_demo.py --apply` 後 demo Lead 0、demo Contact 只剩 Avery
- N4 T1–T9 跑一輪 → `collect_results.py` T1–T8 8/8、T9 PASS
- N5 整批重送 → 全部 `duplicate_submission`、沒有新草稿、T6 仍是 400、Lead／Contact 數不變
- N6 電話比對：送一封只有電話、和既有 Lead 同號但格式不同的詢問 → 掛到同一筆（驗 `phoneSearch`；若索引延遲導致失敗，照實記錄）

### 9.3 E2E（真的 OpenAI；每輪先問使用者）
- E1 reset 後 `LLM_MODE=live` 跑 T1–T9 → 照實記錄 N/8 和 T9；有出入不改 fixture 預期去湊
- E2 `compare_results.py` 產生並排表
- E3 demo 收件匣剛好 2 封核准的回覆
- E4 Salesforce UI 截圖（使用者拍）：Lead 列表（tier 欄）、Dana 的 Lead 與 2 筆詢問 Task＋2 筆決定 Task、Avery 的 Contact 底下的 Task

### 9.4 預期（`fixtures.json` 的 `expect`）
| # | 預期 |
|---|---|
| T1 | 建 Lead、qualified、草稿改稿後 approved |
| T2 | updated、同一筆 Lead、該 Lead 的詢問 Task 2 筆、最終 tier qualified、approved 未改稿 |
| T3 | duplicate_submission、同一筆 Lead、T1 只有 1 份草稿 |
| T4 | 建 Lead、not_qualified、沒有草稿 |
| T5 | 建 Lead、needs_review、草稿被 reject、沒寄 |
| T6 | HTTP 400、Slack 告警、Salesforce 沒寫入 |
| T7 | 建 Lead、needs_review、llm_ok=false、沒有草稿、Slack 告警 |
| T8 | 不完整審核 422；T1 approved＋edited；T2 approved 未改；T5 rejected；收件匣 2 封 |
| T9 | 既有 Contact Avery 寫信 → updated、record_type Contact、同一個 Contact id、沒有建 Lead、詢問 Task 掛在 Contact；草稿 reject |

## 10. 文件
- `README.md`（英文，過 humanizer）：做什麼、架構、跑法、測過什麼、**沒做什麼**、HubSpot 版連結、`## Running this for your own team`、License 句（DESIGN.md §15.2）。
- `docs/SETUP.md`（英文）：從零到跑完 T1–T9，含 External Client App 步驟。
- `docs/OPERATIONS.md`（英文）：改分級規則、加 picklist 值（Salesforce 和 schema 兩邊）、加新來源、看 run log、處理告警、輪替 Consumer Secret。
- `docs/FIELD-MAPPING.md`（英文）：輸入欄位 → Lead／Contact／Task 欄位、預設值、哪些只補空的。
- `docs/VERIFICATION.md`（繁中）。
