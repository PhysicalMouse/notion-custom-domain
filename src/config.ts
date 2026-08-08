/**
 * ============================================================
 *  统一设置文件
 * ------------------------------------------------------------
 *  所有可调整的配置项都集中在这里。
 *  敏感信息(如 Notion Token)通过环境变量读取,其余配置直接在
 *  下方修改即可,无需改动其它代码文件。
 * ============================================================
 */

export interface AppConfig {
  /** 要代理的 Notion 公开页面 URL(根页面) */
  pageUrl: string;

  /** ---------------- Notion 官方 API ---------------- */
  notion: {
    /** Notion 集成 Token(密钥),请在环境变量 NOTION_TOKEN 中设置 */
    token: string;
    /** Notion API 版本 */
    version: string;
    /**
     * 页面中包含的数据库 ID 列表。
     * 页面里可能有多个数据库,把每个数据库 ID 都填进来。
     * 数据库 ID 是 Notion 数据库链接里的 32 位十六进制字符串。
     */
    databaseIds: string[];
    /** 数据库中用于生成 SEO / Slug 的属性名称(区分大小写) */
    propertyNames: {
      /** 标题属性(type = title) */
      title: string;
      /** 描述属性(type = rich_text),用于 SEO description */
      description: string;
      /** Slug 属性(type = rich_text),用于自定义 URL */
      slug: string;
    };
  };

  /** ---------------- 站点默认 SEO ---------------- */
  seo: {
    /** 根页面默认标题;留空则使用 Notion 原始标题 */
    defaultTitle: string;
    /** 根页面默认描述 */
    defaultDescription: string;
    /** 站点名称(用于 og:site_name) */
    siteName: string;
  };

  /** ---------------- 站点验证 ---------------- */
  verification: {
    /** Google Search Console 验证码(google-site-verification 的 content 值) */
    google: string;
    /** Bing Webmaster 验证码(msvalidate.01 的 content 值) */
    bing: string;
  };

  /** ---------------- 分析统计 ---------------- */
  analytics: {
    /** Google Analytics 4 衡量 ID,例如 G-XXXXXXXXXX;默认读取环境变量 GA_MEASUREMENT_ID */
    googleAnalyticsId: string;
    /** 是否启用 Vercel Analytics */
    vercelAnalytics: boolean;
    /** 是否启用 Vercel Speed Insights */
    vercelSpeedInsights: boolean;
  };

  /**
   * ---------------- 缓存刷新 ----------------
   * SEO / Slug 数据的内存缓存刷新间隔(毫秒)。
   * 默认 1 小时;可按需调大或调小。
   */
  refreshIntervalMs: number;
}

export const config: AppConfig = {
  pageUrl:
    process.env.PAGE_URL ??
    'https://notion.notion.site/Notion-Official-83715d7703ee4b8699b5e659a4712dd8',

  notion: {
    token: process.env.NOTION_TOKEN ?? '',
    version: '2022-06-28',
    databaseIds: [
      // '在此填入数据库 ID',
    ],
    propertyNames: {
      title: 'Name',
      description: 'Description',
      slug: 'Slug',
    },
  },

  seo: {
    defaultTitle: '',
    defaultDescription: '',
    siteName: '',
  },

  verification: {
    google: '',
    bing: '',
  },

  analytics: {
    googleAnalyticsId: process.env.GA_MEASUREMENT_ID ?? '',
    vercelAnalytics: true,
    vercelSpeedInsights: true,
  },

  // 1 小时 = 60 * 60 * 1000 毫秒
  refreshIntervalMs: 60 * 60 * 1000,
};
