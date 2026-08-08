/**
 * ============================================================
 *  统一设置文件(项目根目录)
 * ------------------------------------------------------------
 *  所有可调整的配置项都集中在这里。
 *  - 开关类用 true / false 控制启用与关闭。
 *  - 需要填写的验证码 / ID 类,不使用时留空字符串 '' 即可。
 *  敏感信息(如 Notion Token)通过环境变量读取。
 * ============================================================
 */

export interface AppConfig {
  /** 要代理的 Notion 公开页面 URL(根页面) */
  pageUrl: string;

  /** ---------------- Notion 官方 API ---------------- */
  notion: {
    /** Notion 集成 Token，读取环境变量 NOTION_TOKEN */
    token: string;
    /** Notion API 版本 */
    version: string;
    /**
     * 数据库会从根页面自动检测,无需手动填写。
     * 如需强制指定额外数据库(例如链接式数据库无法自动发现),
     * 把数据库 ID 填在这里作为补充,不需要则留空数组。
     */
    extraDatabaseIds: string[];
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
    /** 根页面默认描述;留空则不输出 */
    defaultDescription: string;
    /** 站点名称(用于 og:site_name);留空则不输出 */
    siteName: string;
  };

  /** ---------------- 站点验证 ---------------- */
  verification: {
    /** 是否启用 Google Search Console 验证 */
    google: boolean;
    /** Google 验证码(google-site-verification 的 content 值),google 为 false 时可留空 */
    googleCode: string;
    /** 是否启用 Bing Webmaster 验证 */
    bing: boolean;
    /** Bing 验证码(msvalidate.01 的 content 值),bing 为 false 时可留空 */
    bingCode: string;
  };

  /** ---------------- 分析统计 ---------------- */
  analytics: {
    /** 是否启用 Google Analytics */
    googleAnalytics: boolean;
    /** Google Analytics 4 衡量 ID,例如 G-XXXXXXXXXX;googleAnalytics 为 false 时可留空 */
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
    'https://physicalmouse.notion.site/264686b24bf08004a950c99ffcdfecc5',

  notion: {
    token: process.env.NOTION_TOKEN ?? '',
    version: '2022-06-28',
    extraDatabaseIds: [],
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
    google: false,
    googleCode: '',
    bing: true,
    bingCode: '96B332BE8C0729927B4C665A4E31D77A',
  },

  analytics: {
    googleAnalytics: false,
    googleAnalyticsId: '',
    vercelAnalytics: true,
    vercelSpeedInsights: false,
  },

  // 1 小时 = 60 * 60 * 1000 毫秒
  refreshIntervalMs: 24 * 60 * 60 * 1000,
};
