/* 简约主题模块：加载简约主题 CSS/配置，提供图标路径、工具栏文字、画布背景色等功能 */
const SimplifyTheme = {
  name: 'simplify',
  config: null,

  /**
   * 计算当前页面到项目根目录的相对路径
   * @returns {string} 相对路径，如 "../"
   */
  fetch_base_path() {
    const parts = window.location.pathname.split('/').filter(p => p);
    const depth = Math.max(0, parts.length - 1);
    return '../'.repeat(depth);
  },

  /**
   * 加载主题 CSS 和 JSON 配置，按 settings/主页面注入不同样式表
   * @param {boolean} isSettingsPage - 是否在设置页面中加载
   */
  async load_theme(isSettingsPage = false) {
    const base = this.fetch_base_path();
    const [themeRes, configRes] = await Promise.all([
      fetch(`${base}themes/simplify/theme.json`),
      fetch(`${base}themes/simplify/config.json`)
    ]);
    const [themeJson, configJson] = await Promise.all([
      themeRes.json(),
      configRes.json()
    ]);
    this.config = { ...themeJson, ...configJson };

    if (isSettingsPage) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${base}themes/simplify/settings.css`;
      document.head.appendChild(link);
    } else {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${base}themes/simplify/theme.css`;
      document.head.appendChild(link);
    }
  },

  /**
   * 根据图标名称获取简约主题图标完整路径
   * @param {string} iconName - 图标名称
   * @returns {string} 图标 SVG 路径
   */
  fetch_icon_path(iconName) {
    const actualName = this.config?.icons?.[iconName] || iconName;
    const base = this.fetch_base_path();
    return `${base}themes/simplify/icons/${actualName}.svg`;
  },

  /**
   * 获取简约主题是否显示工具栏文字
   * @returns {boolean}
   */
  fetch_toolbar_text() {
    return this.config?.showToolbarText !== false;
  },

  /**
   * 获取简约主题的画布背景色
   * @returns {string} CSS 颜色值
   */
  fetch_canvas_bg_color() {
    return this.config?.canvasBgColor || '#ffffff';
  },

  /**
   * 获取无摄像头时的文案样式
   * @returns {Object} 包含 textColor 等样式属性的对象
   */
  fetch_no_camera_style() {
    return this.config?.noCameraMessage || {
      textColor: '#1a1a1a',
      secondaryTextColor: 'rgba(0,0,0,0.6)',
      tertiaryTextColor: 'rgba(0,0,0,0.4)',
      textShadow: '0 1px 3px rgba(255,255,255,0.5)'
    };
  },

  /**
   * 获取简约主题是否启用极光背景效果
   * @returns {boolean}
   */
  fetch_aurora_effect() {
    return this.config?.showAuroraEffect !== false;
  }
};

export default SimplifyTheme;
