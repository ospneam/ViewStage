const DarkTheme = {
  name: 'dark',
  config: null,
  
  getBasePath() {
    const parts = window.location.pathname.split('/').filter(p => p);
    const depth = Math.max(0, parts.length - 1);
    return '../'.repeat(depth);
  },
  
  async load(isSettingsPage = false) {
    const base = this.getBasePath();
    const response = await fetch(`${base}themes/dark/theme.json`);
    this.config = await response.json();
    
    if (isSettingsPage) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${base}themes/dark/settings.css`;
      document.head.appendChild(link);
    } else {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${base}themes/dark/theme.css`;
      document.head.appendChild(link);
    }
  },
  
  getIconPath(iconName) {
    const actualName = this.config?.icons?.[iconName] || iconName;
    const base = this.getBasePath();
    return `${base}themes/dark/icons/${actualName}.svg`;
  },
  
  getShowToolbarText() {
    return this.config?.showToolbarText !== false;
  },
  
  getCanvasBgColor() {
    return this.config?.canvasBgColor || '#1a1a1a';
  },
  
  getNoCameraMessageStyle() {
    return this.config?.noCameraMessage || {
      textColor: '#ffffff',
      secondaryTextColor: 'rgba(255,255,255,0.7)',
      tertiaryTextColor: 'rgba(255,255,255,0.5)',
      textShadow: '0 1px 3px rgba(0,0,0,0.5)'
    };
  },

  getShowAuroraEffect() {
    return this.config?.showAuroraEffect !== false;
  }
};

export default DarkTheme;
