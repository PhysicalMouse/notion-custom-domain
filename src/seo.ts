import { config } from '../config.js';

/** 单条页面的 SEO 元数据 */
export interface PageMeta {
  /** Notion 页面 ID(去掉连字符的 32 位字符串) */
  pageId: string;
  /** 标题 */
  title: string;
  /** 描述,可能为空 */
  description: string;
  /** 用于 URL 的 slug(精简) */
  slug: string;
}

const NOTION_API = 'https://api.notion.com/v1';

/** 去掉 UUID 中的连字符,得到 Notion URL 里使用的 32 位字符串 */
function stripDashes(id: string): string {
  return id.replace(/-/g, '');
}

/**
 * 从任意 Notion 字符串(URL、slug、页面路径)中提取末尾的 32 位十六进制 ID。
 * 例如:
 *   "PhysicalMouse-s-Blog-264686b24bf08004a950c99ffcdfecc5"
 *     -> "264686b24bf08004a950c99ffcdfecc5"
 *   "https://xx.notion.site/Notion-Official-83715d77...dd8"
 *     -> "83715d77...dd8"
 * 未找到时返回去连字符后的原字符串。
 */
export function extractNotionId(input: string): string {
  if (!input) return '';
  const cleaned = input.split(/[?#]/)[0]; // 去掉 query / hash
  const lastSegment = cleaned.split('/').filter(Boolean).pop() ?? cleaned;
  const compact = stripDashes(lastSegment);
  const match = compact.match(/[0-9a-fA-F]{32}$/);
  // 仅当末尾是 32 位十六进制(Notion 自动生成格式)时才精简;
  // 否则原样返回(保留纯自定义 slug,如 "my-clean-slug")。
  return match ? match[0].toLowerCase() : lastSegment;
}

/** 从 Notion 属性中提取纯文本(支持 title / rich_text 类型) */
function readPlainText(property: any): string {
  if (!property) return '';
  const parts = property.title ?? property.rich_text;
  if (Array.isArray(parts)) {
    return parts
      .map((part: any) => part?.plain_text ?? '')
      .join('')
      .trim();
  }
  return '';
}

/** 通用的 Notion API 请求封装 */
async function notionFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.notion.token}`,
      'Notion-Version': config.notion.version,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${path} 失败: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * 内存缓存的 SEO 存储。
 * - byPageId: 以 pageId(32 位)为键,查询任意页面的 SEO
 * - bySlug: 以自定义 slug 为键,查询 SEO
 * - slugToPageId: 自定义 slug -> pageId,用于把美观 URL 路由到对应页面
 */
class SeoStore {
  private byPageId = new Map<string, PageMeta>();
  private bySlug = new Map<string, PageMeta>();
  private slugToPageId = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshedAt = 0;

  /**
   * 根据请求路径的第一段查询 SEO 元数据。
   * 同时支持自定义 slug 和 Notion 原始页面路径(含标题前缀)。
   */
  getMeta(key: string): PageMeta | undefined {
    if (!key) return undefined;
    return this.bySlug.get(key) ?? this.byPageId.get(extractNotionId(key));
  }

  /** 根据自定义 slug 解析出目标 Notion 页面 ID */
  resolvePageId(slug: string): string | undefined {
    return this.slugToPageId.get(slug);
  }

  get updatedAt(): number {
    return this.lastRefreshedAt;
  }

  /** 读取某个块的所有子块(自动翻页) */
  private async getBlockChildren(blockId: string): Promise<any[]> {
    const results: any[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
      const json = await notionFetch(`/blocks/${blockId}/children${query}`);
      results.push(...(json.results ?? []));
      cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  /**
   * 从根页面递归检测所有子数据库(child_database)。
   * 会进入列、分栏、折叠块等容器,最多递归 4 层。
   */
  private async discoverDatabaseIds(rootPageId: string): Promise<string[]> {
    const found = new Set<string>();

    const visit = async (blockId: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let children: any[] = [];
      try {
        children = await this.getBlockChildren(blockId);
      } catch (error) {
        console.error('[NCD][SEO] 读取块失败', (error as Error).message);
        return;
      }
      for (const block of children) {
        if (block.type === 'child_database') {
          found.add(stripDashes(block.id));
        } else if (block.has_children) {
          await visit(block.id, depth + 1);
        }
      }
    };

    await visit(rootPageId, 0);
    return [...found];
  }

  /** 查询单个数据库的所有条目(自动翻页) */
  private async queryDatabase(databaseId: string): Promise<any[]> {
    const results: any[] = [];
    let cursor: string | undefined;
    do {
      const json = await notionFetch(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
      });
      results.push(...(json.results ?? []));
      cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  /** 把一条 Notion 记录解析为 PageMeta */
  private toPageMeta(record: any): PageMeta | null {
    const props = record.properties ?? {};
    const { title, description, slug } = config.notion.propertyNames;

    const pageId = stripDashes(record.id ?? '');
    if (!pageId) return null;

    const titleText = readPlainText(props[title]);
    const descriptionText = readPlainText(props[description]);
    const slugText = readPlainText(props[slug]);

    // 有 Slug 属性则用它(精简);否则回退到精简的 pageId
    const resolvedSlug = slugText ? extractNotionId(slugText) || slugText : pageId;

    return {
      pageId,
      title: titleText,
      description: descriptionText,
      slug: resolvedSlug,
    };
  }

  /** 从所有数据库重新拉取并重建缓存 */
  async refresh(): Promise<void> {
    if (!config.notion.token) {
      // 未配置 Token 时跳过(仍可注入默认 SEO / 验证 / 分析)
      return;
    }

    const rootPageId = extractNotionId(config.pageUrl);

    // 自动检测 + 手动补充的数据库
    let databaseIds: string[] = [];
    try {
      databaseIds = await this.discoverDatabaseIds(rootPageId);
    } catch (error) {
      console.error('[NCD][SEO] 数据库自动检测失败', (error as Error).message);
    }
    for (const id of config.notion.extraDatabaseIds) {
      const compact = stripDashes(id);
      if (compact && !databaseIds.includes(compact)) databaseIds.push(compact);
    }

    if (databaseIds.length === 0) {
      console.info('[NCD][SEO] 未发现任何数据库');
      this.lastRefreshedAt = Date.now();
      return;
    }

    const nextByPageId = new Map<string, PageMeta>();
    const nextBySlug = new Map<string, PageMeta>();
    const nextSlugToPageId = new Map<string, string>();
    const { slug: slugPropName } = config.notion.propertyNames;

    for (const databaseId of databaseIds) {
      try {
        const records = await this.queryDatabase(databaseId);
        for (const record of records) {
          const meta = this.toPageMeta(record);
          if (!meta) continue;

          const hasCustomSlug = Boolean(
            readPlainText(record.properties?.[slugPropName]),
          );

          nextByPageId.set(meta.pageId, meta);
          nextBySlug.set(meta.slug, meta);

          // 仅当存在自定义 slug 且与 pageId 不同时,才建立美观 URL 路由
          if (hasCustomSlug && meta.slug !== meta.pageId) {
            nextSlugToPageId.set(meta.slug, meta.pageId);
          }
        }
      } catch (error) {
        console.error('[NCD][SEO]', (error as Error).message);
      }
    }

    this.byPageId = nextByPageId;
    this.bySlug = nextBySlug;
    this.slugToPageId = nextSlugToPageId;
    this.lastRefreshedAt = Date.now();
    console.info(
      '[NCD][SEO]',
      `已刷新 ${databaseIds.length} 个数据库、${nextByPageId.size} 条页面 SEO、${nextSlugToPageId.size} 条 slug 路由`,
    );
  }

  /** 启动:立即刷新一次,并按配置的间隔定时刷新 */
  start(): void {
    if (this.timer) return;
    // 首次加载(失败不阻塞服务)
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, config.refreshIntervalMs);
    // 定时器不应阻止进程退出
    this.timer.unref?.();
  }
}

export const seoStore = new SeoStore();
