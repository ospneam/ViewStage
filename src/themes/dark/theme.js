const DarkTheme = {
  name: 'dark',
  config: null,
  
  async load(isSettingsPage = false) {
    const response = await fetch('themes/dark/theme.json');
    this.config = await response.json();
    
    if (isSettingsPage) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'themes/dark/settings.css';
      document.head.appendChild(link);
    } else {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'themes/dark/theme.css';
      document.head.appendChild(link);
    }
  },
  
  getIconPath(iconName) {
    const actualName = this.config?.icons?.[iconName] || iconName;
    return `themes/dark/icons/${actualName}.svg`;
  },
  
  getShowToolbarText() {
    return this.config?.showToolbarText !== false;
  },
  
  getCanvasBgColor() {
    return this.config?.canvasBgColor || '#2a2a2a';
  },
  
  getNoCameraMessageStyle() {
    return this.config?.noCameraMessage || {
      textColor: '#ffffff',
      secondaryTextColor: 'rgba(255,255,255,0.8)',
      tertiaryTextColor: 'rgba(255,255,255,0.5)',
      textShadow: '0 1px 3px rgba(0,0,0,0.5)'
    };
  }
};

export default DarkTheme;
