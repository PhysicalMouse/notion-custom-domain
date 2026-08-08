import { config } from './config.js';

/** 单条页面的 SEO 元数据 */
export interface PageMeta {
  /** Notion 页面 ID(去掉连字符的 32 位字符串) */
  pageId: string;
  /** 标题 */
  title: string;
  /** 描述,可能为空 */
  description: string;
  /** 用于 URL 的 slug */
  slug: string;
}

const NOTION_API = 'https://api.notion.com/v1';

/** 去掉 UUID 中的连字符,得到 Notion URL 里使用的 32 位字符串 */
function stripDashes(id: string): string {
  return id.replace(/-/g, '');
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

/** 把标题转换成兜底 slug(无 Slug 属性时使用) */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 内存缓存的 SEO 存储。
 * - byKey: 以 slug 和 pageId 为键,查询任意页面的 SEO
 * - slugToPageId: 自定义 slug -> pageId,用于把美观 URL 路由到对应页面
 */
class SeoStore {
  private byKey = new Map<string, PageMeta>();
  private slugToPageId = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshedAt = 0;

  /** 根据请求路径的第一段查询 SEO 元数据 */
  getMeta(key: string): PageMeta | undefined {
    return this.byKey.get(key);
  }

  /** 根据自定义 slug 解析出目标 Notion 页面 ID */
  resolvePageId(slug: string): string | undefined {
    return this.slugToPageId.get(slug);
  }

  get updatedAt(): number {
    return this.lastRefreshedAt;
  }

  /** 查询单个数据库的所有条目(自动翻页) */
  private async queryDatabase(databaseId: string): Promise<any[]> {
    const results: any[] = [];
    let cursor: string | undefined;

    do {
      const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.notion.token}`,
          'Notion-Version': config.notion.version,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Notion API 查询失败 (${databaseId}): ${res.status} ${text}`,
        );
      }

      const json: any = await res.json();
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

    // 有 Slug 属性则用它;否则用标题兜底,再退回 pageId(原始页面字符)
    const resolvedSlug =
      slugText || slugifyTitle(titleText) || pageId;

    return {
      pageId,
      title: titleText,
      description: descriptionText,
      slug: resolvedSlug,
      // 标记是否为用户自定义 slug,便于路由判断
    } as PageMeta & { custom?: boolean };
  }

  /** 从所有数据库重新拉取并重建缓存 */
  async refresh(): Promise<void> {
    if (!config.notion.token || config.notion.databaseIds.length === 0) {
      // 未配置 Token 或数据库时,跳过(仍可注入默认 SEO / 验证 / 分析)
      return;
    }

    const nextByKey = new Map<string, PageMeta>();
    const nextSlugToPageId = new Map<string, string>();
    const { slug: slugPropName } = config.notion.propertyNames;

    for (const databaseId of config.notion.databaseIds) {
      try {
        const records = await this.queryDatabase(databaseId);
        for (const record of records) {
          const meta = this.toPageMeta(record);
          if (!meta) continue;

          const hasCustomSlug = readPlainText(
            record.properties?.[slugPropName],
          );

          // SEO 可通过 slug 或 pageId 两种键查到
          nextByKey.set(meta.slug, meta);
          nextByKey.set(meta.pageId, meta);

          // 仅当存在自定义 slug 时才建立路由映射
          if (hasCustomSlug && meta.slug !== meta.pageId) {
            nextSlugToPageId.set(meta.slug, meta.pageId);
          }
        }
      } catch (error) {
        console.error('[NCD][SEO]', (error as Error).message);
      }
    }

    this.byKey = nextByKey;
    this.slugToPageId = nextSlugToPageId;
    this.lastRefreshedAt = Date.now();
    console.info(
      '[NCD][SEO]',
      `已刷新 ${nextByKey.size} 条页面 SEO,${nextSlugToPageId.size} 条 slug 路由`,
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
