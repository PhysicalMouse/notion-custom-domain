/* Notion API 的 property/block 联合类型随数据库配置动态变化。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
  /** Notion 原始字符路径，用于没有 Slug 属性时的 SEO 收录 */
  originalPath: string;
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
  private lastRefreshedAt = 0;
  private refreshPromise?: Promise<void>;

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

  /**
   * 返回某请求键(slug 或 Notion 页面路径)对应页面的「自定义 slug」。
   * 仅当该页面确实设置了 Slug 属性时才返回;否则返回 undefined
   * (此时应保留 Notion 原始 URL,符合「没有 Slug 就用原页面字符」的规则)。
   */
  canonicalSlug(key: string): string | undefined {
    const meta = this.getMeta(key);
    if (!meta) return undefined;
    return this.slugToPageId.get(meta.slug) === meta.pageId
      ? meta.slug
      : undefined;
  }

  /**
   * 页面 ID -> 浏览器显示路径。
   * 有 Slug 时显示 Slug；普通 child_page 没有 Slug 时显示纯页面 ID。
   * SEO canonical 仍由 canonicalSlug 单独控制，不会误收录纯 ID。
   */
  getPageSlugMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const meta of this.byPageId.values())
      result[meta.pageId] = meta.pageId;
    for (const [slug, pageId] of this.slugToPageId) result[pageId] = slug;
    return result;
  }

  /**
   * 网站地图使用：有自定义 Slug 时仅返回 Slug；否则返回精简的纯页面 ID
   * (而非标题前缀的 Notion 原始字符路径),与站内实际链接
   * (见 getPageSlugMap)保持一致,避免收录冗长的 URL。
   */
  getSitemapPaths(): string[] {
    return [...this.byPageId.values()].map((meta) =>
      this.slugToPageId.get(meta.slug) === meta.pageId
        ? meta.slug
        : meta.pageId,
    );
  }

  get updatedAt(): number {
    return this.lastRefreshedAt;
  }

  /** 读取某个块的所有子块(自动翻页) */
  private async getBlockChildren(blockId: string): Promise<any[]> {
    const results: any[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor
        ? `?start_cursor=${cursor}&page_size=100`
        : '?page_size=100';
      const json = await notionFetch(`/blocks/${blockId}/children${query}`);
      results.push(...(json.results ?? []));
      cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  /**
   * 通过 Notion Search API 检测所有对集成可见的数据库。
   * 相比只爬根页面的 child_database 块,这种方式能可靠地发现:
   *   - 链接式数据库视图(linked database)
   *   - 嵌套很深或位于分栏 / 折叠块内的数据库
   * 这些正是「有些页面仍保留 Blender- 前缀、未命中 Slug」的原因。
   */
  private async searchNotionObjects(
    object: 'database' | 'page',
  ): Promise<any[]> {
    const found: any[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filter: { property: 'object', value: object },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;
      const json = await notionFetch('/search', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      found.push(
        ...(json.results ?? []).filter(
          (item: any) => item.object === object && item.id,
        ),
      );
      cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor);
    return found;
  }

  private async searchDatabaseIds(): Promise<string[]> {
    return (await this.searchNotionObjects('database')).map((database) =>
      stripDashes(database.id),
    );
  }

  /** 搜索 Integration 可见的普通子页面，包括 child_page。 */
  private async searchPages(): Promise<any[]> {
    return this.searchNotionObjects('page');
  }

  /**
   * 从根页面递归检测所有子数据库(child_database)。
   * 会进入列、分栏、折叠块等容器,最多递归 4 层。
   * 作为 Search API 的补充,防止个别数据库未被搜索索引。
   */
  private async crawlDatabaseIds(rootPageId: string): Promise<string[]> {
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

    const titleProperty =
      props[title] ??
      Object.values(props).find((property: any) => property?.type === 'title');
    const titleText = readPlainText(titleProperty);
    const descriptionText = readPlainText(props[description]);
    const slugText = readPlainText(props[slug]);

    // 有 Slug 属性则用它(精简);否则回退到精简的 pageId
    const resolvedSlug = slugText
      ? extractNotionId(slugText) || slugText
      : pageId;

    const originalPath =
      String(record.url ?? '')
        .split(/[?#]/)[0]
        .split('/')
        .filter(Boolean)
        .pop() ?? pageId;

    return {
      pageId,
      title: titleText,
      description: descriptionText,
      slug: resolvedSlug,
      originalPath,
    };
  }

  /** 从所有数据库重新拉取并重建缓存 */
  async refresh(): Promise<void> {
    if (!config.notion.token) {
      // 未配置 Token 时跳过(仍可注入默认 SEO / 验证 / 分析)
      return;
    }

    const rootPageId = extractNotionId(config.pageUrl);

    // 自动检测(Search API 为主 + 根页面爬取为辅)+ 手动补充
    const ids = new Set<string>();
    try {
      for (const id of await this.searchDatabaseIds()) ids.add(id);
    } catch (error) {
      console.error('[NCD][SEO] Search API 检测失败', (error as Error).message);
    }
    try {
      for (const id of await this.crawlDatabaseIds(rootPageId)) ids.add(id);
    } catch (error) {
      console.error('[NCD][SEO] 根页面爬取失败', (error as Error).message);
    }
    for (const id of config.notion.extraDatabaseIds) {
      const compact = stripDashes(id);
      if (compact) ids.add(compact);
    }
    const databaseIds = [...ids];

    if (databaseIds.length === 0) {
      console.info('[NCD][SEO] 未发现数据库，将继续检测普通子页面');
    }

    const nextByPageId = new Map<string, PageMeta>();
    const nextBySlug = new Map<string, PageMeta>();
    const nextSlugToPageId = new Map<string, string>();
    const { slug: slugPropName } = config.notion.propertyNames;

    const addRecord = (record: any): void => {
      const meta = this.toPageMeta(record);
      if (!meta) return;

      const hasCustomSlug = Boolean(
        readPlainText(record.properties?.[slugPropName]),
      );
      nextByPageId.set(meta.pageId, meta);
      nextBySlug.set(meta.slug, meta);

      if (hasCustomSlug && meta.slug !== meta.pageId) {
        nextSlugToPageId.set(meta.slug, meta.pageId);
      }
    };

    for (const databaseId of databaseIds) {
      try {
        for (const record of await this.queryDatabase(databaseId)) {
          addRecord(record);
        }
      } catch (error) {
        console.error('[NCD][SEO]', (error as Error).message);
      }
    }

    // 数据库查询不会返回普通 child_page；Search API 补齐这些页面。
    try {
      for (const page of await this.searchPages()) addRecord(page);
    } catch (error) {
      console.error('[NCD][SEO] 普通子页面检测失败', (error as Error).message);
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

  /**
   * 确保缓存可用。
   * 冷启动或缓存过期时只发起一次刷新，所有并发请求共享同一个 Promise。
   * Vercel Serverless 不保证 setInterval 持续运行，因此改为请求驱动刷新。
   */
  async ensureFresh(): Promise<void> {
    const isEmpty = this.byPageId.size === 0;
    const isExpired =
      Date.now() - this.lastRefreshedAt >= config.refreshIntervalMs;
    if (!isEmpty && !isExpired) return;

    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    await this.refreshPromise;
  }

  /** 进程启动时预热；首个页面请求仍会通过 ensureFresh 等待结果。 */
  start(): void {
    void this.ensureFresh();
  }
}

export const seoStore = new SeoStore();
