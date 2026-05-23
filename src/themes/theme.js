/* 主题管理器：加载、切换内置/用户主题，提供图标路径、工具栏文字、画布背景色等主题配置查询 */
const ThemeManager = {
  currentTheme: null,
  currentThemeModule: null,
  userThemePath: null,
  isSettingsPage: false,

  BUILTIN_PACKAGES: {
    'com.viewstage.theme.dark': 'dark',
    'com.viewstage.theme.simplify': 'simplify'
  },

  /**
   * 初始化主题管理器，加载指定主题（默认从配置读取）
   * @param {string|null} themeName - 主题包名，不传则从后端配置读取
   */
  async init(themeName = null) {
    this.isSettingsPage = window.location.pathname.includes('settings.html');
    
    if (!themeName) {
      themeName = await this.theme_fetch_saved();
    }
    
    await this.theme_update_active(themeName);
  },

  /**
   * 从后端配置中获取已保存的主题包名
   * @returns {Promise<string>} 主题包名
   */
  async theme_fetch_saved() {
    if (window.__TAURI__) {
      try {
        const { invoke } = window.__TAURI__.core;
        const settings = await invoke('settings_fetch_all');
        return settings?.theme || 'com.viewstage.theme.simplify';
      } catch (e) {
        console.warn('无法获取保存的主题设置:', e);
      }
    }
    return 'com.viewstage.theme.simplify';
  },

  /**
   * 加载并激活指定主题，按内置→用户主题顺序查找
   * @param {string} themeName - 主题包名
   */
  async theme_update_active(themeName) {
    try {
      let themeModule = null;
      const builtinDir = this.BUILTIN_PACKAGES[themeName];
      
      if (builtinDir) {
        const module = await import(`./${builtinDir}/theme.js`);
        themeModule = module.default;
      } else if (window.__TAURI__) {
        if (!this.userThemePath) {
          const { invoke } = window.__TAURI__.core;
          try {
            this.userThemePath = await invoke('dir_fetch_theme');
          } catch (e) {
            console.warn('无法获取用户主题目录:', e);
          }
        }
        
        if (this.userThemePath) {
          const userThemeDir = `${this.userThemePath}/${themeName}`;
          const hasUserTheme = await this.theme_validate_user(userThemeDir);
          
          if (hasUserTheme) {
            themeModule = await this.theme_load_user(userThemeDir, themeName);
          }
        }
      }
      
      if (!themeModule) {
        console.error(`Theme not found: ${themeName}`);
        return;
      }
      
      this.currentThemeModule = themeModule;
      this.currentTheme = themeName;
      
      if (this.currentThemeModule.load_theme) {
        await this.currentThemeModule.load_theme(this.isSettingsPage);
      }
      this.theme_update_toolbar_text_visibility();
      this.theme_load_icons();
    } catch (error) {
      console.error(`Failed to load theme: ${themeName}`, error);
    }
  },

  /**
   * 检查主题名是否为内置主题
   * @param {string} themeName - 主题包名
   * @returns {boolean}
   */
  theme_validate_builtin(themeName) {
    return !!this.BUILTIN_PACKAGES[themeName];
  },

  theme_fetch_builtin_dir(themeName) {
    return this.BUILTIN_PACKAGES[themeName] || null;
  },

  async theme_validate_user(themeDir) {
    if (!window.__TAURI__) return false;
    
    const { fs } = window.__TAURI__;
    try {
      const configPath = `${themeDir}/theme.json`;
      const content = await fs.readTextFile(configPath);
      return !!content;
    } catch {
      return false;
    }
  },

  async theme_load_user(themeDir, themeName) {
    const { fs, convertFileSrc } = window.__TAURI__;

    let mergedConfig = {};

    try {
      const themeJsonPath = `${themeDir}/theme.json`;
      const themeJsonContent = await fs.readTextFile(themeJsonPath);
      const themeJson = JSON.parse(themeJsonContent);
      mergedConfig = { ...themeJson };
    } catch (e) {
      console.warn('User theme missing theme.json:', e);
    }

    try {
      const configPath = `${themeDir}/config.json`;
      const configContent = await fs.readTextFile(configPath);
      const config = JSON.parse(configContent);
      mergedConfig = { ...mergedConfig, ...config };
    } catch (e) {
      console.warn('User theme missing config.json:', e);
    }

    return {
      name: themeName,
      config: mergedConfig,
      themeDir: themeDir,
      
      async load_theme() {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = convertFileSrc(`${this.themeDir}/theme.css`);
        document.head.appendChild(link);
      },
      
      fetch_icon_path(iconName) {
        const actualName = this.config?.icons?.[iconName] || iconName;
        return convertFileSrc(`${this.themeDir}/icons/${actualName}.svg`);
      },
      
      fetch_toolbar_text() {
        return this.config?.showToolbarText !== false;
      },
      
      fetch_canvas_bg_color() {
        return this.config?.canvasBgColor || '#2a2a2a';
      },
      
      fetch_aurora_effect() {
        return this.config?.showAuroraEffect !== false;
      }
    };
  },

  /**
   * 获取当前激活的主题包名
   * @returns {string|null} 主题包名
   */
  theme_fetch_current() {
    return this.currentTheme;
  },

  /**
   * 获取主题是否显示工具栏文字标签
   * @returns {boolean} true=显示文字，false=仅图标
   */
  theme_fetch_toolbar_text() {
    if (this.currentThemeModule && this.currentThemeModule.fetch_toolbar_text) {
      return this.currentThemeModule.fetch_toolbar_text();
    }
    return true;
  },

  /**
   * 获取主题的画布背景色
   * @returns {string} CSS 颜色值，默认 '#2a2a2a'
   */
  theme_fetch_canvas_bg_color() {
    if (this.currentThemeModule && this.currentThemeModule.fetch_canvas_bg_color) {
      return this.currentThemeModule.fetch_canvas_bg_color();
    }
    return '#2a2a2a';
  },

  /**
   * 获取无摄像头画面时的叠加文案样式
   * @returns {Object} 包含 textColor、secondaryTextColor、tertiaryTextColor、textShadow 的样式对象
   */
  theme_fetch_no_camera_style() {
    if (this.currentThemeModule && this.currentThemeModule.fetch_no_camera_style) {
      return this.currentThemeModule.fetch_no_camera_style();
    }
    return {
      textColor: '#ffffff',
      secondaryTextColor: 'rgba(255,255,255,0.8)',
      tertiaryTextColor: 'rgba(255,255,255,0.5)',
      textShadow: '0 1px 3px rgba(0,0,0,0.5)'
    };
  },

  /**
   * 获取主题是否启用极光背景效果
   * @returns {boolean} 默认 true
   */
  theme_fetch_aurora_effect() {
    if (this.currentThemeModule && this.currentThemeModule.fetch_aurora_effect) {
      return this.currentThemeModule.fetch_aurora_effect();
    }
    return true;
  },

  /**
   * 根据主题配置切换工具栏文字标签的显隐
   */
  theme_update_toolbar_text_visibility() {
    const toolbar = document.querySelector('.toolbar');
    if (toolbar) {
      if (this.theme_fetch_toolbar_text()) {
        toolbar.classList.remove('hide-text');
      } else {
        toolbar.classList.add('hide-text');
      }
    }
  },

  /**
   * 根据图标名称获取完整的图标资源路径
   * @param {string} iconName - 图标名称（不含扩展名）
   * @returns {string} 图标资源相对/绝对路径
   */
  theme_fetch_icon_path(iconName) {
    if (this.currentThemeModule && this.currentThemeModule.fetch_icon_path) {
      return this.currentThemeModule.fetch_icon_path(iconName);
    }
    const dir = this.BUILTIN_PACKAGES[this.currentTheme] || this.currentTheme;
    return `themes/${dir}/icons/${iconName}.svg`;
  },

  /**
   * 生成图标的 img 标签 HTML 字符串
   * @param {string} iconName - 图标名称
   * @param {Object} [options] - 可选参数 {width, height, alt, style}
   * @param {number} [options.width=16] - 图标宽度
   * @param {number} [options.height=16] - 图标高度
   * @param {string} [options.alt=''] - 替代文本
   * @param {string} [options.style=''] - 额外样式
   * @returns {string} img 标签
   */
  theme_fetch_icon(iconName, options = {}) {
    const { width = 16, height = 16, alt = '', style = '' } = options;
    const src = this.theme_fetch_icon_path(iconName);
    return `<img src="${src}" width="${width}" height="${height}" alt="${alt}" style="${style}">`;
  },

  /**
   * 扫描 DOM 中所有 data-icon 属性元素并加载对应图标
   */
  theme_load_icons() {
    const icons = document.querySelectorAll('[data-icon]');
    icons.forEach(img => {
      const iconName = img.getAttribute('data-icon');
      img.src = this.theme_fetch_icon_path(iconName);
    });
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ThemeManager.init());
} else {
  ThemeManager.init();
}

export default ThemeManager;
