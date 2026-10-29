# 驗證紀錄

環境：本機 Docker n8n 2.44.7（port 5680，compose 專案 `lead-intake-sf-demo`）、Salesforce Developer Edition（API v63.0，External Client App＋client credentials）、demo Gmail（沿用 HubSpot 版）、新的 Slack webhook（`#lead-alerts-salesforce`）。檢查 ID 對照 `SPEC.md` §9。日期 2026-10-30（台灣時間）。

## 9.1 離線
| ID | 指令 | 結果 |
|---|---|---|
| O1 | `node --test "n8n-src/code/*.test.js" "n8n-src/*.test.mjs"` | **PASS**：57 個測試全過 |
| O2 | `python -m unittest discover tests_scripts` | **PASS**：25 個測試全過 |
| O3 | `node n8n-src/build-workflows.mjs` 跑兩次後比對 | **PASS**：5 個 workflow，兩次輸出相同；Code node 語法檢查 0 錯誤；沒有 HubSpot 字樣 |
| O4 | `python scripts/send_fixtures.py --dry-run` | **PASS**：列出 T1–T7、T9，沒有機密 |

## 9.2 n8n 本機（mock LLM，真的 Salesforce／Gmail／Slack）
| ID | 結果 |
|---|---|
| N1 | **PASS**：`salesforce_setup.py` 建了 13 個欄位、permission set（13 筆欄位權限）並指派、T9 的 demo Account 與 Contact；再跑一次全部略過。Task 的 `Inquiry_Source_ID__c` 讀回是 unique＋externalId＋caseSensitive（Developer Edition 接受，沒有退回一般欄位） |
| N2 | **PASS**：n8n 的 `oAuth2Api` credential（client credentials）自己換到 token，Composite 查詢成功。401 重換 token 還沒遇到過，沒有驗證 |
| N3 | **PASS**：`reset_demo.py --apply` 刪掉 demo 記錄後重建 Avery，demo Lead 0、Contact 1 |
| N4 | **PASS 8/8＋T9**：`send_fixtures.py` → `--review` → `collect_results.py`。Salesforce 有 4 個 Lead（Dana、Jordan、Sam、Riley）＋ Avery 的 Contact；Dana 底下 2 筆詢問 Task＋2 筆決定 Task；T9 掛在 Avery 的 Contact，沒有建 Lead；demo 收件匣 2 封 |
| N5 | **PASS 9/9**：`send_fixtures.py --replay` 整批重送（含 3 封同 Message-ID 的信）→ 7 筆全是 `duplicate_submission`、沒有新草稿、T6 仍是 400、Lead／Contact 仍是 5 筆 |
| N6 | **PASS**（另外手動送的兩份表單，不在 T1–T9 裡；沒有 mock 回答，所以 AI 走失敗路徑、Slack 有告警，這裡只看比對）：<br>・(a) 只有電話 `510.555.0177`、沒有 email → `matched_by=leadPhone`，更新 Riley 既有的 Lead<br>・(b) 先用 API 建一筆「人手輸入」的 Lead（Jamie，`(510) 555-0199`，沒有 E.164 欄位），約 5 分鐘後送只有電話 `510-555-0199` 的表單 → `matched_by=phoneSearch`，更新同一筆 Lead，`Phone` 保持原樣、`Phone_E164__c` 補上 `+15105550199`。兩次都沒有建新 Lead |

## 9.3 E2E（真的 OpenAI，gpt-4.1-mini；使用者 2026-10-30 同意後跑）
| ID | 結果 |
|---|---|
| E1 | **PASS：live 第 1 輪 T1–T8 8/8、T9 PASS**（台灣時間 04:05–04:07，只跑了 1 輪）。紀錄在 `output/archive-live-round-1/`，去掉收件匣地址的副本在 `results/salesforce-live-round-1.json` |
| E2 | **PASS**：`compare_results.py` 產生並排表，HubSpot 8/8、Salesforce 8/8（`output/results-side-by-side.md`） |
| E3 | **PASS**：demo 收件匣剛好 2 封核准的回覆（T1 改稿版、T2 原稿）；T5、T9 被 reject，沒有寄出 |
| E4 | **NOT RUN**：Salesforce UI 截圖由使用者拍（作品集那一步） |

另外直接用 API 驗了一次唯一值：對 Dana 的 Lead 再建一筆 `Inquiry_Source_ID__c = form:tw-demo-0001` 的 Task → Salesforce 回 400 `DUPLICATE_VALUE`，沒有存進去。所以「同一個 source ID 不會有第二筆 Task」是 Salesforce 擋的，不只是查詢擋的。

並排表要照實說明：HubSpot 那欄是它的 live **第 2 輪**（第 1 輪 4/8，修了引用長度檢查後重跑）；Salesforce 這輪用的是已經修好的同一份 `llm.js`，所以第 1 輪就 8/8。

### 真實 AI 的分級
| # | AI 判斷 | 跟預期 |
|---|---|---|
| T1 | qualified（run log） | 一致 |
| T2 | needs_review（「沒講坪數、頻率」）；Lead 依不降級規則維持 qualified | 一致（最終 tier） |
| T4 | not_qualified／sales_pitch／low | 一致 |
| T5 | needs_review／quote_request／normal | 一致 |
| T7 | OpenAI 真的回 404 → needs_review、告警 | 一致 |
| T9 | qualified／deep_cleaning／normal | 一致 |

### live 跑出來、要照實寫的限制
- **草稿看不到同一人之前的詢問**（和 HubSpot 版一樣）：T2 的草稿又問 Dana 辦公室多大、多久清一次，她在 T1 已經寫了。照 fixture 設定未改稿直接 approve 寄出。
- **`AI_Reason__c` 以最新一封為準，tier 卻保留較高的分級**（和 HubSpot 版一樣）：Dana 是 qualified，但理由寫的是 T2 的「沒講坪數、頻率」。
- **T9 的草稿有點過度承諾**：「We can definitely add carpet cleaning … during your next monthly deep clean」，prompt 明明寫不能承諾日期。這份照 fixture 被 reject，沒有寄出；這正是人工核准要擋的東西。
- 跑完已切回 `LLM_MODE=mock`。Salesforce 裡留著這一輪的 4 個 Lead＋Avery 的 Contact，可以拿來截圖。

## 開發中遇到並修正的問題
1. **Composite 不接受 SOSL**：第一次送 T1，`phoneSearch` 子請求回 404 `NOT_FOUND`。比對程式照設計丟錯、error workflow 發了 Slack 告警，沒有被當成「沒找到」。改成另一個 HTTP 節點，只有在 email 和已存電話都沒找到時才搜。
2. **SOSL 電話格式**：`FIND {+1…}` 回 `MALFORMED_SEARCH`（`+` 被當成 bind 變數），`510-555-0188` 也會語法錯誤；只送 10 碼數字可以找到存成 `+15105550188` 的記錄。新記錄要等幾分鐘才搜得到（剛建 Avery 時搜不到，幾分鐘後就搜得到）。
3. **demo 模式擋掉只有電話的詢問**：從 HubSpot 版沿用的規則是「沒有 `@example` email 就拒收」，所以只有電話的詢問永遠進不來（HubSpot 版的電話比對沒觸發過，原因就在這）。改成 demo 模式下也接受電話在虛構 555-0100–0199 範圍的詢問；reset 也會清掉這類記錄。
4. **表單詢問的 Task 主旨都一樣**：表單整理後主旨固定是 `Website contact form`，Task 列表會看不出差別。表單詢問改用訊息開頭當主旨，email 詢問照樣用信件主旨。

## 與 SPEC 不同的地方（已同步更新 SPEC）
- 電話搜尋從 Composite 拆出來（SPEC §4 第 2.5 點）。
- demo 寫入範圍加上 555-01xx 電話（SPEC §1 第 6 點）。

## 目前 Salesforce 裡的資料
- live 第 1 輪的 5 筆 demo 記錄（Dana、Jordan、Sam、Riley 的 Lead，Avery 的 Contact）。**拍完截圖之前不要 reset 或重跑。**
- 一開始試送 T1 時留下一個在等待審核的 n8n execution（舊版 workflow），約 2026-11-02 逾時。它對應的 Lead 已經被刪掉，逾時時寫 Task 會失敗，可能會發一則錯誤告警；不影響結果。

## 待辦
- 無（README、SETUP、OPERATIONS 已改寫成 Salesforce 版，README 過了 humanizer）。
