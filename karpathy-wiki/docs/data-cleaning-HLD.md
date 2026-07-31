# Karpathy-Wiki 鏁版嵁娓呮礂瀛愮郴缁?姒傝璁捐鏂囨。 (HLD)

- 鏂囨。鐗堟湰: v1.0
- 鏃ユ湡: 2026-07-25
- 鐘舵€? 璇勫閫氳繃
- 璁捐渚濇嵁: [data-cleaning-SRS-v1.0](../data-cleaning-SRS.md)
- 瀛愮郴缁熶綅缃? api/src/routes/data-clean.ts + frontend/src/views/DataClean.vue
- 闆嗘垚妯″潡: vault-service.ts, compile-workflow.ts, cleanup.ts, search-util.ts

---

## 1. 姒傝堪

### 1.1 璁捐鑼冨洿

鏈璁℃枃妗ｅ畾涔夋暟鎹竻娲楀瓙绯荤粺鐨勬€讳綋鏋舵瀯銆佹ā鍧楀垝鍒嗐€佹帴鍙ｈ璁°€佹暟鎹祦鍜屽畨鍏ㄧ瓥鐣ャ€?
娑电洊 F-1 璐ㄩ噺鎵弿寮曟搸銆丗-2 鍘婚噸妫€娴嬨€丗-3 鎶ュ憡 API銆丗-4 鍓嶇 Dashboard銆?
F-6 瓒呭ぇ鏂囦欢鍘嬬缉銆丗-8 鎵归噺褰掓。鎿嶄綔銆?

### 1.2 璁捐鐩爣

| 鐩爣 | 閲忓寲鎸囨爣 |
|---|---|
| 鍏ㄩ噺鎵弿鑰楁椂 | < 30 绉掞紙135 姝ｅ紡椤?+ 168 raw/鏂囦欢锛?|
| 璐ㄩ噺璇勫垎鍑嗙‘鐜?| > 95%锛堜笌浜哄伐璇勪及涓€鑷达級 |
| 鍘婚噸妫€娴嬪彫鍥炵巼 | > 90%锛堝凡鐭?4 瀵归噸澶嶅潎妫€鍑猴級 |
| 瀛樺偍鑺傜渷棰勪及 | ~159 MB锛?6.5%锛?|
| 鏃犱笟鍔′腑鏂?| 鎵弿涓嶅奖鍝嶅凡鏈夐棶绛斿拰缂栬瘧鎿嶄綔 |

### 1.3 鏋舵瀯鍘熷垯

1. **澶嶇敤鐜版湁鍩虹璁炬柦**锛歏aultService 璇诲啓銆乬ray-matter frontmatter 瑙ｆ瀽銆丗astify 璺敱妗嗘灦
2. **闈炰镜鍏ュ紡鎵╁睍**锛氫笉淇敼 compile-workflow.ts 鏍稿績閫昏緫锛岄€氳繃 precheck 鎺ュ彛杩斿洖缁撴灉
3. **瀹夊叏浼樺厛**锛氭墍鏈夊啓鎿嶄綔榛樿 dry-run锛屽璁℃棩蹇椾笉鍙垹闄?
4. **娓愯繘寮忎氦浠?*锛歅hase 1锛堝熀纭€鎵弿锛夆啋 Phase 2锛堜慨澶嶆搷浣滐級鈫?Phase 3锛堥妫€璋冨害锛?

### 1.4 璁捐绾︽潫

- 鍚庣鎶€鏈爤锛歍ypeScript + Fastify + Node.js fs/promises + gray-matter
- 鍓嶇鎶€鏈爤锛歏ue 3 + TypeScript + Element Plus + CSS variables锛堝凡瀹氫箟 .style.css锛?
- 鏁版嵁搴擄細鏃狅紙绾枃浠剁郴缁熸寔涔呭寲锛宎udit log 鐢?JSONL 杩藉姞锛?
- AI 渚濊禆鍙€夛細frontmatter 淇鍙敤 LLM锛岄檷绾ф柟妗堜负瑙勫垯鎻愬彇
锘?--

## 2. 鎬讳綋鏋舵瀯璁捐

### 2.1 鏋舵瀯鎬昏

鏁版嵁娓呮礂瀛愮郴缁熼噰鐢?*涓夊眰鍒嗙鏋舵瀯**锛屼笌鐜版湁 Karpathy-Wiki 涓夊眰鏋舵瀯鍏煎锛?

```
+-----------------------------------------------------+
|                    Presentation Layer                 |
|  DataClean.vue (Vue 3 + Element Plus + glass-card)   |
|  - QualityDashboard (score distribution chart)       |
|  - PageListTable (sortable/filterable table)         |
|  - DuplicateViewer (side-by-side comparison)         |
|  - ScheduleConfigForm (cron expression input)        |
+----------------------+-------------------------------+
                       | HTTP REST API / SSE
+----------------------v-------------------------------+
|                 Application Layer                     |
|  data-clean.ts (Fastify routes)                      |
|  - DataCleanRoute (endpoint router, auth middleware) |
|  - QualityScannerService (bulk scan coordinator)    |
|  - DeduplicationEngine (minhash similarity engine)  |
|  - ReportGenerator (aggregation + summary builder)  |
|  - FixExecutor (dry-run -> confirm -> execute)      |
|  - PrecheckGate (compile-time quality gate)         |
|  - SchedulerManager (cron job runner)               |
+----------------------+-------------------------------+
                       | Direct API calls
+----------------------v-------------------------------+
|                  Infrastructure Layer                 |
|  VaultService (existing: read/write/frontmatter)     |
|  SearchUtil (existing: inbound link graph)           |
|  CompileCache (existing: content hash for de-dup)    |
|  RunLogger (existing: audit log writer)              |
|  gray-matter (npm: YAML frontmatter parser)          |
+----------------------+-------------------------------+
                       | Filesystem
+----------------------v-------------------------------+
|                   Data Layer                          |
|  data/vault/entities/*.md       (formal pages)       |
|  data/vault/concepts/*.md       (formal pages)       |
|  data/vault/comparisons/*.md    (formal pages)       |
|  data/vault/raw/*              (unprocessed files)   |
|  .harness/data-clean-audit.log (immutable audit)     |
|  archive/YYYY-MM-DD/*         (backup before delete) |
|  docs/data-cleaning-reports/* (scheduled report)     |
+-----------------------------------------------------+
```

### 2.2 妯″潡鑱岃矗鍒掑垎

| 妯″潡 | 鍖?绫诲悕 | 鑱岃矗 | 渚濊禆 |
|---|---|---|---|
| **鍏ュ彛璺敱** | `DataCleanRoute` | Fastify 娉ㄥ唽銆佽璇侀壌鏉冦€佽姹傚弬鏁版牎楠?| VaultService |
| **璐ㄩ噺鎵弿寮曟搸** | `QualityScannerService` | 閬嶅巻 vault 鐩綍銆侀€愰〉璇勫垎銆佹眹鎬绘姤鍛?| File system, gray-matter |
| **鍘婚噸妫€娴嬪櫒** | `DeduplicationEngine` | 椤甸潰鎸囩汗璁＄畻銆佺浉浼煎害姣斿銆佸垎缁勮緭鍑?| QualityScannerService |
| **鎶ュ憡鐢熸垚鍣?* | `ReportGenerator` | 鑱氬悎缁熻銆佸垎绾у垎甯冦€佸瓨鍌ㄨ妭鐪佷及绠?| QualityScannerService, DeduplicationEngine |
| **淇鎵ц鍣?* | `FixExecutor` | frontmatter 淇銆佹憳瑕佺敓鎴愩€佸綊妗ｆ搷浣?| LLM API (optional), File system |
| **缂栬瘧鍓嶉妫€** | `PrecheckGate` | 鍦?compile 鍓嶆嫤鎴綆璐ㄩ噺 draft | QualityScannerService |
| **璋冨害绠＄悊鍣?* | `SchedulerManager` | node-cron 鍛ㄦ湡浠诲姟銆佹姤鍛婃寔涔呭寲 | Node.js cron, ReportGenerator |

### 2.3 鏁版嵁娴佽璁?

#### 鍦烘櫙 A: 鍏ㄩ噺鎵弿 + 鎶ュ憡

```
User clicks Start Scan -> POST /api/data-clean/report(dry_run=true)
  -> DataCleanRoute validates permission
  -> QualityScannerService.scan(vaultPath, options)
     - scan() iterates directoryList[entities, concepts, comparisons]
     - For each *.md file:
         - readContent(file) -> VaultService.readFile()
         - extractMetadata(content) -> wordCount, lineCount, BOM check
         - extractFrontmatter(content) -> gray-matter.parse()
         - countLinks(content) -> /\[\[.*?\]\]/g
     - buildInboundLinkGraph(allPages)
     - computeScores(perPage) -> 6-dimension weighted sum
  -> ReportGenerator.aggregate(allPages, duplicates)
     - scoreDistribution(count per grade)
     - topIssues(group by issue code)
     - estimatedStorageSavings()
  -> SSE stream: progress(step=scan_done) -> done(report={...})
```

#### 鍦烘櫙 B: 鍘婚噸妫€娴?

```
POST /api/data-clean/deduplicate
  -> dedupParams.minSimilarity = 0.85
  -> DeduplicationEngine.detect(allPages)
     - fingerprint() for each page:
         - titleHash = sha256(normalized(title))
         - firstParagraphShingles = shingleify(body, k=5)
         - combined = { titleHash, shingleHash }
     - pairwiseCompare(candidatePairs):
         - if same titleHash: exactMatch = true
         - else: jaccardScore = |A n B| / |A u B|
         - if score >= threshold: nearDuplicate
     - groupByRepresentative(duplicates)
  -> Return: DeduplicateResult { matches, duplicateGroups, scannedPages, uniquePages }
```

#### 鍦烘櫙 C: Frontmatter 淇

```
POST /api/data-clean/fix-frontmatter { paths: [...], dryRun: true }
  -> FixExecutor.fixFrontmatter(paths, dryRun)
     - for each page in paths:
         - content = readContent(page)
         - parsed = grayMatter.parse(content)
         - missingFields = REQUIRED_FIELDS - existingFields
         - if missingFields.length > 0:
             - titleFromHeading = extractFirstH1() || fileNameWithoutExt()
             - typeFromDir = inferTypeFromDirectory()
             - newFrontmatter = generateYamlBlock({title, type, tags, ...})
             - result.fixed[] = { path, addedFields, confidence, preview }
     - if !dryRun: writeModifiedFiles(results.fixed[].preview)
```

#### 鍦烘櫙 D: 瓒呭ぇ鏂囦欢鍘嬬缉

```
POST /api/data-clean/summarize-large { path: "...", maxSummaryWords: 2000 }
  -> FixExecutor.summarizeLargeFile(path, maxWords)
     - content = readContent(path)
     - chunks = splitIntoChunks(content, chunkSize=5000 words)
     - extractKeySections(chunks)
     - composeSummary(keyParagraphs, maxWords)
     - saveSummary(summary, targetDir + "/.summaries/")
     - moveToArchive(path, destDir: archive/YYYY-MM-DD/)
     - return SummarizeLargeFileResult
```

#### 鍦烘櫙 E: 鎵归噺褰掓。鎿嶄綔

```
POST /api/data-clean/archive { paths: [...], reason: "..." }
  -> FixExecutor.batchArchive(paths, reason)
     - archiveDate = format(new Date(), "YYYY-MM-DD")
     - mkdir(archiveDir, recursive=true)
     - for each path in paths:
         - copySync(path, backupDest)  // disaster recovery
         - moveSync(path, archiveDir)
         - log to .harness/data-clean-audit.log JSONL
     - return ArchiveResult
```

### 2.4 缁勪欢浜や簰鍥?

```
+------------------------------------------+
|              Client (Browser)             |
|  +------------------------------------+  |
|  |  DataClean.vue                     |  |
|  |  +------------+  +-------------+   |  |
|  |  | Dashboard  |  | Page List   |   |  |
|  |  | Chart      |  | Table       |   |  |
|  |  +------------+  +-------------+   |  |
|  |  +------------+  +-------------+   |  |
|  |  | Duplicates |  | Fix Actions |   |  |
|  |  | Viewer     |  | Panel       |   |  |
|  |  +------------+  +-------------+   |  |
|  +------------------------------------+  |
+-----------------+------------------------+
                  | fetch(/api/data-clean/*) + SSE
+-----------------v------------------------+
|         Fastify Server (api/src/index.ts) |
|  +------------------------------------+  |
|  |  AuthMiddleware (RBAC: dataclean)  |  |
|  +------------------------------------+  |
|  +------------------------------------+  |
|  |  /api/data-clean/* Router          |  |
|  |  GET  /report      -> ReportCtrl   |  |
|  |  GET  /pages       -> PageListCtrl |  |
|  |  POST /deduplicate -> DedupCtrl    |  |
|  |  POST /fix-frontmatter -> FixCtrl  |  |
|  |  POST /summarize-large -> SummCtrl |  |
|  |  POST /archive       -> ArchiveCtrl|  |
|  |  POST /precheck      -> PrecheckCtrl|  |
|  +------------------------------------+  |
|              | delegates to services     |
|  +------------------------------------+  |
|  |  Service Layer                      |  |
|  |  QualityScannerService              |  |
|  |  DeduplicationEngine                |  |
|  |  FixExecutor                        |  |
|  |  PrecheckGate                       |  |
|  |  SchedulerManager                   |  |
|  +------------------------------------+  |
+-----------------+------------------------+
                  |
+-----------------v------------------------+
|         Core Services (existing)          |
|  +------------------------------------+  |
|  |  VaultService (readFile, writeFile)|  |
|  |  SearchUtil (searchPages for refs) |  |
|  |  CompileCache (SHA-256 hashes)     |  |
|  |  RunLogger (audit log writer)      |  |
|  +------------------------------------+  |
+-----------------+------------------------+
                  |
+-----------------v------------------------+
|          File System (data/vault/)        |
|  +----------+-----------+---------------+|
|  | entities | concepts  | comparisons   ||
|  |  .md     |   .md     |    .md        ||
|  +----------+-----------+---------------+|
|  +----------+-----------+---------------+|
|  | raw      | drafts    | queries       ||
|  | *.md     | qa/*.md   |  *.md         ||
|  +----------+-----------+---------------+|
+------------------------------------------+

---



---

## 3. 妯″潡璇︾粏璁捐

### 3.1 璐ㄩ噺鎵弿寮曟搸 (QualityScannerService)

**鑱岃矗**: 閬嶅巻 vault/ 涓嬫墍鏈夌洰褰曪紝璁＄畻姣忎釜椤甸潰鐨?6 缁村害璐ㄩ噺璇勫垎銆?
#### 绫荤粨鏋?
```typescript
// api/src/data-clean/quality-scanner.ts

export class QualityScannerService {
  private vaultPath: string;
  private pageDirs: string[];         // ['entities', 'concepts', 'comparisons', 'raw']
  private inboundLinkGraph: Map<string, Set<string>>;  // target -> sources
  
  constructor(vaultPath: string) { ... }
  
  async scan(options?: ScanOptions): Promise<DataCleanReport> { ... }
  
  private async buildInboundLinkGraph(): Promise<void> { ... }
  private async scanDirectory(dir: string): Promise<PageQualityScore[]> { ... }
  private computeScore(page: PageInfo): PageQualityScore { ... }
  
  private calcLengthScore(wordCount: number): number { ... }     // 20%
  private calcLinksScore(outboundLinks: number): number { ... }   // 25%
  private calcFrontmatterScore(fm: Record<string, unknown>): number { ... } // 20%
  private calcCitationScore(inboundLinks: number): number { ... } // 15%
  private calcFreshnessScore(daysSinceUpdate: number): number { ... } // 10%
}
```

#### 鏍稿績绠楁硶浼唬鐮?
```python
function scan(vaultDir, options):
  allPages = []
  for dir in options.directories:
    files = listFiles(vaultDir + "/" + dir, "*.md")
    for file in files:
      if file.matches(test-*|proxy-test*): skip
      content = readFile(file)
      fm = parse_yaml_frontmatter(content)
      allPages.append({path: relativePath(file), title: fm.title, content: content})
  inboundGraph = empty_map()
  for page in allPages:
    targets = extract_wiki_link_targets(page.content)
    for target in targets:
      resolved = resolve_wiki_link_to_path(target)
      if resolved exists and resolved in allPages:
        inboundGraph[resolved].add(page.path)
  scoredPages = []
  for page in allPages:
    score = 0.0
    length_pct = min(100, page.wordCount / 10)
    links_pct = min(100, page.outboundLinks * 25)
    fm_score = 0
    if 'title' in page.frontmatterFields: fm_score += 10
    if 'type' in page.frontmatterFields: fm_score += 10
    citation_pct = min(100, len(inboundGraph.get(page.path, [])) * 10)
    score = length_pct * 0.20 + links_pct * 0.25 + fm_score * 0.20 + citation_pct * 0.15
    scoredPages.append(score)
  return scoredPages
```

#### 寮傚父澶勭悊绛栫暐

```python
try:
  page_data = scan_single_file(filepath)
except FileCorruptError:
  report.add_error("Corrupt file", filepath)
  continue
except PermissionDenied:
  report.add_warning("Permission denied", filepath)
  continue
```

### 3.2 鍘婚噸妫€娴嬫ā鍧?(DeduplicationEngine)

**鑱岃矗**: 浣跨敤 minhash 杩戜技閲嶅妫€娴?+ Jaccard 绮剧‘楠岃瘉銆?
#### 绫荤粨鏋?
```typescript
export class DeduplicationEngine {
  private readonly SHINGLE_SIZE = 5;       // 5-gram shingles
  private readonly NUM_HASH_FUNCTIONS = 100;  // MinHash cardinality
  private readonly SIMILARITY_THRESHOLD = 0.85;
  
  async detect(pages: PageInfo[]): Promise<DuplicateGroup[]> { ... }
}
```

#### 绠楁硶姝ラ

```python
# Step 1: Generate page fingerprints
fingerprints = {}
for page in pages:
  text_for_fp = truncate(page.body, max_words=5000)
  title_hash = sha256(normalize_unicode(page.title))
  shingles = set(ngrams(split_words(text_for_fp), n=SHINGLE_SIZE))
  minhash_signature = compute_minhash(shingles, k=NUM_HASH_FUNCTIONS)
  fingerprints[page.path] = {
    title_hash: title_hash,
    shingle_set: shingles,
    minhash: minhash_signature
  }

# Step 2: Pre-filter by title hash (exact duplicate detection)
exact_pairs = []
title_buckets = group_by(fingerprints, lambda fp: fp.title_hash)
for bucket in title_buckets.values():
  if len(bucket) > 1:
    exact_pairs.extend(combinations(bucket, 2))

# Step 3: Candidate pair generation via LSH
bands = 10
rows_per_band = 10
lsh_buckets = make_lsh_buckets(fingerprints, bands, rows_per_band)
candidate_pairs = set()
for band_id in range(bands):
  for group in group_by(lsh_buckets[band_id]).values():
    if len(group) >= 2:
      candidate_pairs.update(combinations(group, 2))

# Step 4: Verify candidates with exact Jaccard similarity
verified_duplicates = []
for (path_a, path_b) in candidate_pairs | set(exact_pairs):
  jaccard = jaccard_similarity(
    fingerprints[path_a].shingle_set,
    fingerprints[path_b].shingle_set
  )
  if jaccard >= SIMILARITY_THRESHOLD:
    match_type = classify_match_type(path_a, path_b, jaccard)
    verified_duplicates.append({
      pageA: fingerprint[path_a],
      pageB: fingerprint[path_b],
      similarity: round(jaccard, 4),
      matchType: match_type  # 'exact' | 'near-duplicate' | 'semantic-similar'
    })

return deduplicate_groups(verified_duplicates)
```

#### 澶嶆潅搴﹀垎鏋?
| 鎿嶄綔 | 鏃堕棿澶嶆潅搴?| 璇存槑 |
|---|---|---|
| Shingle extraction | O(N x L) | N=pages, L=max words per page |
| MinHash computation | O(N x K) | K=100 |
| LSH candidate generation | O(N) amortized | |
| Jaccard verification | O(S^2) worst case | Pruned by LSH |
| Total | ~O(N x L + S^2) | Fast for 135 pages |

### 3.3 淇鎵ц鍣?(FixExecutor)

**鑱岃矗**: frontmatter 鑷姩淇銆佽秴澶ф枃浠舵憳瑕佺敓鎴愩€佸綊妗ｆ搷浣溿€?
#### 3.3.1 Frontmatter 淇

```python
async def fix_frontmatter(paths, dry_run=True):
  results = []
  
  REQUIRED_FIELDS = {'title', 'type', 'created', 'updated', 'source', 'tags'}
  EXTENDED_FIELDS = {'status', 'confidence', 'original_refs'}
  
  for path in paths:
    content = vault_service.read_file(path)
    parsed = gray_matter.parse(content)
    existing_fields = set(parsed.data.keys())
    missing = REQUIRED_FIELDS - existing_fields
    
    if not missing:
      continue  # already has complete frontmatter
    
    new_fm = {}
    
    h1_match = re.search(r'^#s+(.+)$', parsed.content, re.MULTILINE)
    new_fm['title'] = h1_match.group(1) if h1_match else path.rstrip('.md')
    
    dir_name = path.split('/')[0]
    type_map = {
      'entities': 'entity',
      'concepts': 'concept', 
      'comparisons': 'comparison',
      'queries': 'query'
    }
    new_fm['type'] = type_map.get(dir_name, 'concept')
    
    if USE_LLM_FOR_TAGS:
      tags = await llm_extract_tags(parsed.content, top_n=5)
    else:
      tags = rule_based_keywords(parsed.content)[:5]
    new_fm['tags'] = tags
    
    new_fm['created'] = extract_creation_date(path) or today_str()
    new_fm['updated'] = today_str()
    new_fm['source'] = path  # traceable source
    
    confidence = 'high' if path in manual_review_approved else 'medium'
    
    if not dry_run:
      updated_content = gray_matter.stringify(parsed.content, new_fm)
      vault_service.write_file(path, updated_content)
    
    results.append({
      path: path,
      addedFields: list(missing | new_fm.keys()),
      confidence: confidence,
      preview: "---\n" + yaml.dump(new_fm) + "---\n" + parsed.content[:200]
    })
  
  return {fixed: results, errors: [], dryRun: dry_run}
```

#### 3.3.2 瓒呭ぇ鏂囦欢鎽樿鐢熸垚

```python
async def summarize_large_file(path, max_summary_words=2000):
  content = vault_service.read_file(path)
  total_words = count_words(content)
  
  if total_words <= 10000:
    raise ValueError("File not large enough to need summarization")
  
  chunks = split_into_paragraph_chunks(content, chunk_size=500)
  
  sections = []
  current_heading = None
  current_text = []
  
  for line in chunks:
    heading_match = re.match(r'^(#{1,3})s+(.+)$', line)
    if heading_match:
      if current_heading:
        sections.append((current_heading, join(current_text, '\n')))
      current_heading = heading_match.group(2)
      current_text = []
    else:
      current_text.append(line)
  
  if current_heading:
    sections.append((current_heading, join(current_text, '\n')))
  
  sections.sort(key=lambda s: len(s[1]), reverse=True)
  selected_sections = sections[:max(3, len(sections)//5)]
  
  summary_parts = []
  total_so_far = 0
  for heading, text in selected_sections:
    if total_so_far + count_words(text) > max_summary_words:
      summary_parts.append(heading + '\n' + truncate(text, max_summary_words - total_so_far))
      break
    summary_parts.append(heading + '\n' + text)
    total_so_far += count_words(text)
  
  summary_text = '\n---\n'.join(summary_parts) + f'\n\n<!-- Summary of {total_words}-word original -->'
  
  summary_path = path.replace('.md', '-summary.md')
  if dry_run is False:
    save_summary(summary_path, summary_text)
    move_to_archive(path)
  
  return SummarizeLargeFileResult(
    originalPath=path,
    originalSize=byte_count(content),
    originalWordCount=total_words,
    summaryPath=summary_path,
    summarySize=byte_count(summary_text),
    summaryWordCount=count_words(summary_text),
    keyTopics=[s[0] for s in sections[:10]],
    storageSavedBytes=byte_count(content) - byte_count(summary_text),
    movedToArchive=not dry_run
  )
```

#### 3.3.3 鎵归噺褰掓。鎿嶄綔

```python
async def batch_archive(paths, reason, move_only=False):
  archive_date = format_date(now(), "YYYY-MM-DD")
  archive_root = f"data/vault/archive/{archive_date}/"
  audit_log = ".harness/data-clean-audit.log"
  
  archived = []
  errors = []
  
  ensure_dir(f"{archive_root}/backup/")
  
  for path in paths:
    try:
      relative = normalize_path(path)
      backup_dest = f"{archive_root}/backup/{relative}.bak"
      archive_dest = f"{archive_root}/{relative}"
      
      copy_file(path, backup_dest)
      
      if not move_only:
        if file_checksum(path) == file_checksum(backup_dest):
          remove_file(path)
          
      archived.append({
        from: path,
        to: archive_dest,
        sizeFreed: stat(backup_dest).size
      })
      
      append_jsonl(audit_log, {
        ts: iso_now(),
        action: 'archive',
        source: path,
        dest: archive_dest,
        reason: reason,
        dry_run: False
      })
      
    except Exception as e:
      errors.append({from: path, error: str(e)})
  
  return ArchiveResult(archived=archived, errors=errors, archiveDirectory=archive_root)
```

### 3.4 缂栬瘧鍓嶉妫€ (PrecheckGate)

**鑱岃矗**: 鍦?compile-workflow 寮€濮嬫柊椤甸潰缂栬瘧鍓嶈繘琛岃川閲忛棬鎺ф鏌ャ€?
**闆嗘垚鐐?*: 淇敼 `compile-workflow.ts` 鐨勫叆鍙ｅ嚱鏁帮紝澧炲姞 precheck 璋冪敤銆?
```python
async function precheckCompilation(newDrafts: string[], threshold: number):
  precheckResult = {passed: true, blockedPages: [], warningPages: [], recommendedActions: []}
  
  for draft_path in newDrafts:
    content = vault_service.read_file(draft_path)
    word_count = count_words(content)
    wiki_links = count_wiki_links(content)
    has_title = bool(re.search(r'^#s+.+', content, re.MULTILINE))
    
    if word_count < 20:
      precheckResult.blockedPages.append({
        path: draft_path,
        reason: f"Content too short ({word_count} words, minimum 20)",
        currentScore: estimate_partial_score(word_count, wiki_links, has_title)
      })
      precheckResult.passed = False
      continue
      
    if word_count < 100:
      precheckResult.warningPages.append({
        path: draft_path,
        reason: f"Content may be incomplete ({word_count} words, recommend 100+)",
        currentScore: estimate_partial_score(word_count, wiki_links, has_title)
      })
      
    if wiki_links == 0:
      precheckResult.recommendedActions.append(
        f"Add [[wiki-links]] in {draft_path} for better knowledge graph connectivity"
      )
  
  return precheckResult
```

**compile-workflow 闆嗘垚浼唬鐮?*:

```python
precheckResult = await precheckGate.run(
  newDrafts=input.pages_to_compile,
  threshold=config.qualityThreshold ?? 30
)

if not precheckResult.passed:
  throw new CompileBlockedError(
    message: f"Compile blocked: {precheckResult.blockedPages.length} pages below quality threshold",
    details: precheckResult
  )

if precheckResult.recommendedActions.length > 0:
  logger.warn('Quality recommendations:', precheckResult.recommendedActions)
```

---

## 4. 绫讳笌鎺ュ彛璁捐

### 4.1 绫诲浘锛堟枃鏈〃绀猴級

`
DataCleanRoute (api/src/routes/data-clean.ts)
鈹溾攢鈹€ QualityScannerService
鈹?  鈹溾攢鈹€ DimensionCalculator (length, links, frontmatter, citations, duplicate, freshness)
鈹?  鈹溾攢鈹€ InboundLinkGraphBuilder
鈹?  鈹斺攢鈹€ FileMetadataExtractor (encoding, BOM, size, timestamps)
鈹溾攢鈹€ DeduplicationEngine
鈹?  鈹溾攢鈹€ MinHashSimulator
鈹?  鈹斺攢鈹€ PairComparator
鈹溾攢鈹€ ReportGenerator
鈹?  鈹溾攢鈹€ ScoreAggregator
鈹?  鈹斺攢鈹€ IssueClassifier
鈹溾攢鈹€ FixExecutor
鈹?  鈹溾攢鈹€ FrontmatterRepairService (LLM-assisted or rule-based fallback)
鈹?  鈹溾攢鈹€ SummarizationService
鈹?  鈹斺攢鈹€ ArchiveService (with audit logging via RunLogger)
鈹溾攢鈹€ PrecheckGate
鈹?  鈹斺攢鈹€ ThresholdValidator
鈹斺攢鈹€ SchedulerManager
    鈹溾攢鈹€ CronJobRunner
    鈹斺攢鈹€ ReportPersister (saves JSON reports to docs/data-cleaning-reports/)
`

### 4.2 鍏抽敭鏂规硶绛惧悕

`	ypescript
// api/src/data-clean/quality-scanner.ts
class QualityScannerService {
  constructor(vault: VaultService)
  async scan(options?: ScanOptions): Promise<DataCleanReport>
  private computeScore(page: PageInfo): PageQualityScore
  private buildInboundLinkGraph(): Map<string, Set<string>>
}

// api/src/data-clean/dedup-engine.ts
class DeduplicationEngine {
  constructor(similarityThreshold: number = 0.85)
  async detect(pages: PageInfo[]): Promise<DuplicateGroup[]>
  private fingerprint(page: PageInfo): PageFingerprint
  private jaccardSimilarity(a: ShingleSet, b: ShingleSet): number
}

// api/src/data-clean/fix-executor.ts
class FixExecutor {
  constructor(vault: VaultService, llmClient?: LlmApiClient)
  
  async fixFrontmatter(
    paths: string[],
    dryRun: boolean = true
  ): Promise<FixFrontmatterResult>
  
  async summarizeLargeFile(
    path: string,
    maxSummaryWords: number = 2000
  ): Promise<SummarizeLargeFileResult>
  
  async batchArchive(
    paths: string[],
    reason: string,
    dryRun: boolean = true
  ): Promise<ArchiveResult>
}

// api/src/data-clean/precheck-gate.ts
class PrecheckGate {
  constructor(threshold: number = 30)
  async validate(draftPaths: string[]): Promise<PrecheckResult>
  private isBelowThreshold(page: PageInfo): boolean
}

// api/src/data-clean/scheduler-manager.ts
class SchedulerManager {
  private schedulesPath: string  // .harness/data-clean-schedules.json
  
  async listSchedules(): Promise<ScheduleConfig[]>
  async createSchedule(config: ScheduleConfig): Promise<void>
  async deleteSchedule(id: string): Promise<void>
  private async runScheduledScan(schedule: ScheduleConfig): Promise<void>
}
`

---

## 5. 鍓嶇璁捐 (DataClean.vue)

### 5.1 缁勪欢缁撴瀯

`
DataClean.vue
鈹溾攢鈹€ QualityDashboard (overview stats)
鈹?  鈹溾攢鈹€ ElStatistic: totalPages, avgScore, criticalCount
鈹?  鈹溾攢鈹€ el-progress (ring): score distribution percentages
鈹?  鈹斺攢鈹€ el-alert: top issues summary
鈹溾攢鈹€ PageListTable
鈹?  鈹溾攢鈹€ el-table: sortable columns (score, words, links, directory)
鈹?  鈹溾攢鈹€ el-radio-group: directory filter chips
鈹?  鈹溾攢鈹€ el-select: sort by dropdown
鈹?  鈹斺攢鈹€ el-pagination: page navigation
鈹溾攢鈹€ DuplicateViewer (modal dialog)
鈹?  鈹溾攢鈹€ el-card side-by-side comparison
鈹?  鈹溾攢鈹€ shared-outline for inline diff
鈹?  鈹斺攢鈹€ action buttons: merge / ignore / keep-both
鈹溾攢鈹€ FixActionsPanel
鈹?  鈹溾攢鈹€ el-button-group for fix-frontmatter (dry-run default)
鈹?  鈹溾攢鈹€ el-input-number for summarize-max-words
鈹?  鈹斺攢鈹€ confirmation dialog for archive operations
鈹斺攢鈹€ ScheduleConfigForm
    鈹溾攢鈹€ el-input with cron validation
    鈹溾攢鈹€ el-switch for enabled/disabled
    鈹斺攢鈹€ test-cron expression button
`

### 5.2 API 璋冪敤灏佽

`	ypescript
// frontend/src/services/data-clean.ts

import { apiErrorMessage } from '../utils/apiError';

export async function scanQuality(options?: ReportRequest): Promise<DataCleanReport> {
  const res = await fetch('/api/data-clean/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...options, dry_run: true })  // default to safe mode
  });
  if (!res.ok) throw new Error(apiErrorMessage('璐ㄩ噺鎵弿澶辫触', res));
  return res.json();
}

export async function triggerDeduplication(): Promise<DeduplicateResult> {
  const res = await fetch('/api/data-clean/deduplicate', { method: 'POST' });
  return res.json();
}

export async function fixFrontmatter(paths: string[], dryRun: boolean): Promise<FixFrontmatterResult> {
  const res = await fetch('/api/data-clean/fix-frontmatter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, dry_run: dryRun })
  });
  return res.json();
}

export async function archiveFiles(paths: string[], reason: string): Promise<ArchiveResult> {
  // Require double confirmation for non-dry-run
  if (!dryRun) {
    await ElMessageBox.confirm(
      \纭褰掓。 \ 涓枃浠讹紵姝ゆ搷浣滀笉鍙挙閿€锛屽缓璁厛澶囦唤銆俓,
      '褰掓。鎿嶄綔纭',
      { confirmButtonText: '纭褰掓。', cancelButtonText: '鍙栨秷', type: 'warning' }
    );
  }
  
  const res = await fetch('/api/data-clean/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, reason, move_only: false })
  });
  return res.json();
}
`

### 5.3 鐘舵€佺鐞嗭紙鍙傝€冪幇鏈?stores/ 妯″紡锛?

`	ypescript
// frontend/src/stores/dataclean.ts
import { defineStore } from 'pinia';

interface DataCleanState {
  report: DataCleanReport | null;
  loading: boolean;
  scanProgress: string | null;  // SSE status message
  selectedPages: string[];       // for batch actions
  auditLog: string[];            // recent audit entries
}

export const useDataCleanStore = defineStore('dataclean', {
  state: (): DataCleanState => ({ report: null, loading: false, ... }),
  actions: {
    async startScan() {
      this.loading = true;
      this.scanProgress = '姝ｅ湪鎵弿 vault/...';
      
      const evtSource = new EventSource('/api/data-clean/scan-stream');
      evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.scanProgress = data.message;
        if (data.event === 'scan_done') {
          this.report = data.payload;
          evtSource.close();
          this.loading = false;
        }
      };
    }
  }
});
`
## 6. 鍏抽敭绠楁硶涓庡鏉傚害鍒嗘瀽

### 6.1 鏃堕棿澶嶆潅搴︽眹鎬?
| 鎿嶄綔 | 杈撳叆瑙勬ā | 鏃堕棿澶嶆潅搴?| 澶囨敞 |
|---|---|---|---|
| 璐ㄩ噺鎵弿 | V 椤甸潰鎬绘暟锛學 骞冲潎姣忛〉瀛楁暟 | O(V 脳 W) | 閫愭枃浠惰鍙?瑙ｆ瀽 |
| inbound link graph | V 椤甸潰 | O(V 脳 L) | L=姣忛〉骞冲潎閾炬帴鏁?|
| MinHash 鎸囩汗鐢熸垚 | V 脳 S (S=shingle set size) | O(V 脳 K) | K=hash鍑芥暟鏁?100) |
| LSH 鍊欓€夊鐢熸垚 | V pages, B bands | O(V 脳 B) | B=band count (10) |
| Jaccard 楠岃瘉 | C candidate pairs, S shingles | O(C 脳 S虏) worst case | 瀹為檯杩滃皬鍥犱负 LSH 鍓灊 |
| frontmatter 淇 | F 寰呬慨椤甸潰 | O(F) | 瑙勫垯鎻愬彇 O(1) per page |
| 瓒呭ぇ鏂囦欢鎽樿 | G words in giant file | O(G chunking + extraction) | 鍙壂鎻?headings + top paragraphs |
| 鎵归噺褰掓。 | A 涓枃浠?| O(A 脳 copy_cost) | 鍏堝浠藉悗绉诲姩 |

### 6.2 绌洪棿澶嶆潅搴?
| 鏁版嵁缁撴瀯 | 澶у皬 | 璇存槑 |
|---|---|---|
| 鍐呭瓨缂撳瓨锛坢etadata锛?| O(V 脳 avg_page_size) | ~250 MB raw/ + ~0.25 MB formal / 1024 鈮?O(V) 瀹為檯鍙 |
| inbound link graph | O(E edges) | E 鈮?V虏 (worst), practical ~V脳D |
| LSH hash tables | O(V 脳 B) | B=10 bands, negligible |
| Report output | O(V + D matches) | D=duplicate pair count |

### 6.3 浼樺寲绛栫暐

**鍦烘櫙**: raw/ 鐩綍鏈?168 涓枃浠讹紝鍏朵腑 12 涓槸 >50K 璇嶇殑宸ㄥ瀷 PDF 鎻愬彇鏂囦欢銆?
**浼樺寲**: 
1. 瀵瑰法鍨嬫枃浠惰烦杩囧叏鏂囧垎鏋愶紝浠呮鏌?metadata锛堟枃浠跺ぇ灏忋€佽鏁般€丅OM锛?2. 鍙鍏剁敓鎴愭憳瑕侊紝涓嶅弬涓庡幓閲嶆瘮杈?3. 鍐呭瓨鍗犵敤浠?~175 MB 闄嶈嚦 ~2 MB

`python
# Optimization decision tree
def should_full_analyze(file_path):
    stats = stat(file_path)
    if stats.word_count > 50000:
        return 'metadata_only'  # Don't do full analysis
    elif stats.is_test_file:
        return 'skip'            # Test files excluded
    else:
        return 'full'            # Normal processing
`

## 7. 寮傚父澶勭悊涓庡閿?
### 7.1 鍒嗗眰閿欒澶勭悊绛栫暐

`
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?          DataCleanRoute                鈹?鈹? 鈹溾攢 Auth check 鈫?401/403               鈹?鈹? 鈹溾攢 Param validation 鈫?400              鈹?鈹? 鈹斺攢 Delegate to service layer           鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?               鈹?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈻尖攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?       Service Layer                    鈹?鈹? 鈹斺攢 Try/catch per-file operations       鈹?鈹?    鈹溾攢 Catch exceptions                 鈹?鈹?    鈹溾攢 Log to audit                     鈹?鈹?    鈹斺攢 Continue to next file            鈹?鈹? 鈹斺攢 Aggregate errors in result.errors[] 鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?               鈹?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈻尖攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?       Infrastructure                   鈹?鈹? 鈹溾攢 VaultService.resolve() path check   鈹?鈹? 鈹溾攢 File system FS operations           鈹?鈹? 鈹斺攢 Gray-matter parsing failures        鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?`

### 7.2 SSE 杩涘害浜嬩欢璁捐

瀵逛簬鑰楁椂 > 5 绉掔殑鎿嶄綔锛堝叏閲忔壂鎻忥級锛屼娇鐢?SSE 鎺ㄩ€佽繘搴︼細

`	ypescript
// Backend sends:
sse.send('progress', { step: 'scan_init', status: 'running', message: '寮€濮嬫壂鎻?..' })
sse.send('progress', { step: 'read_schema', status: 'running', message: '姝ｅ湪鎵弿涓?..' })
sse.send('progress', { step: 'building_graph', status: 'running', message: '鏋勫缓寮曠敤鍥?..' })
sse.send('progress', { step: 'deduplicating', status: 'running', message: '妫€娴嬮噸澶?..' })
sse.send('done', { status: 'done', data: { report: DataCleanReport } })
sse.send('error', { status: 'error', message: '鎵弿澶辫触鍘熷洜' })
`

### 7.3 鍥炴粴鏈哄埗

鎵€鏈?destructive 鎿嶄綔閬靛惊涓夋娴佺▼锛?1. **Backup**: copy source 鈫?archive/YYYY-MM-DD/backup/
2. **Verify**: compare checksums between source and backup
3. **Execute**: move/delete source only after backup confirmed

## 8. 鎵╁睍鎬ц€冭檻

### 8.1 鏈潵鎵╁睍鏂瑰悜

| 鎵╁睍鐐?| 浼樺厛绾?| 瀹炵幇鏂瑰紡 |
|---|---|---|
| 鍚戦噺宓屽叆璇勫垎 | P3 | 鎺ュ叆 Embedding API 璁＄畻璇箟鐩镐技搴?|
| Webhook 閫氱煡 | P3 | 褰撹川閲忓垎涓嬮檷鏃跺彂閫?Slack/DingTalk 閫氱煡 |
| AI 鑷姩淇 | P2 | LLM 鐩存帴鐢熸垚淇鍚庣殑 markdown 鍐呭 |
| 澧為噺鎵弿 | P2 | 鍙壂鎻?lastModified > X days 鐨勯〉闈?|
| 鎻掍欢绯荤粺 | P2 | 鍏佽鐢ㄦ埛娉ㄥ唽鑷畾涔夎川閲忕淮搴︽鏌?|

### 8.2 閰嶇疆鍖栬璁?
鏂板 config.json section锛?
`json
{
  "dataClean": {
    "enabled": true,
    "qualityThreshold": 30,
    "dedupSimilarityThreshold": 0.85,
    "maxSummaryWords": 2000,
    "archiveAutoDays": 30,
    "useLLMForTags": false,
    "scanOnStartup": false
  }
}
`

### 8.3 API 鐗堟湰绠＄悊

璺緞绾﹀畾: /api/data-clean/v1/* 鈥?濡傞渶鍚戝悗鍏煎鍙姞鐗堟湰鍙峰墠缂€銆?
### 8.4 ACL 闆嗘垚

澶嶇敤鐜版湁 RBAC middleware銆俤ataclean permission 鍒嗛厤缁?admin 瑙掕壊銆?
---

## 闄勫綍 A: 渚濊禆娓呭崟

| 渚濊禆 | 绫诲瀷 | 鐢ㄩ€?| 鐗堟湰瑕佹眰 |
|---|---|---|---|
| gray-matter | npm | YAML frontmatter 瑙ｆ瀽 | 宸叉湁 |
| node-cron | npm | 瀹氭椂浠诲姟璋冨害 | new |
| fastify | npm | HTTP 璺敱妗嗘灦 | 宸叉湁 |

## 闄勫綍 B: 涓?SRS 闇€姹傝拷韪煩闃?
| SRS ID | HLD 瀹炵幇浣嶇疆 | 瀹屾垚鐘舵€?|
|---|---|---|
| T-1 璐ㄩ噺鎵弿 | 搂3.1 QualityScannerService | 鉁?|
| T-2 鏅鸿兘鍘婚噸 | 搂3.2 DeduplicationEngine | 鉁?|
| T-3 缂哄け淇 | 搂3.3.1 FrontmatterRepair | 鉁?|
| T-4 鏃犳晥杩囨护 | 搂3.3.3 ArchiveService | 鉁?|
| T-5 鍏ュ彛棰勬 | 搂3.4 PrecheckGate | 鉁?|
| T-6 瀹氭湡宸℃ | 搂3.5 SchedulerManager | 鉁?|
| F-1 ~ F-10 | 瀵瑰簲绔犺妭 | 鉁?鍏ㄩ儴瑕嗙洊 |
