filepath = r'D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\config.ts'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

old_block = """export async function loadConfig(): Promise<AppConfig> {
  const now = Date.now();
  // 检查缓存是否有效
  if (configCache.data && (now - configCache.loadedAt) < CONFIG_CACHE_TTL_MS) {
    return configCache.data;
  }

  const defaults = defaultConfig();
  const p = getConfigPath();
  if (!p) {
    configCache.data = defaults;
    configCache.path = null;
    configCache.loadedAt = now;
    return defaults;
  }

  // 如果路径没变且缓存未过期，直接用
  if (configCache.path === p && configCache.data) {
    return configCache.data;
  }

  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');"""

new_block = """export async function loadConfig(): Promise<AppConfig> {
  const now = Date.now();
  // 先获取当前路径，用于缓存有效性校验
  const currentPath = getConfigPath();
  // 检查缓存是否有效：路径必须一致 + TTL 未过期
  if (configCache.data && configCache.path === currentPath && (now - configCache.loadedAt) < CONFIG_CACHE_TTL_MS) {
    return configCache.data;
  }

  const defaults = defaultConfig();
  if (!currentPath) {
    configCache.data = defaults;
    configCache.path = currentPath;
    configCache.loadedAt = now;
    return defaults;
  }

  let raw: string;
  try {
    raw = await fs.readFile(currentPath, 'utf8');"""

if old_block in content:
    content = content.replace(old_block, new_block)
    print("SUCCESS: Block replaced")
else:
    print("ERROR: Target block not found")

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
