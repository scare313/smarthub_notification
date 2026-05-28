/**
 * API Client / Network Interceptor for SmartHUB Pick Page
 * 
 * Intercepts the actual JSON API responses that the SmartHUB dashboard makes,
 * eliminating the need for fragile DOM scraping of HTML tables.
 * 
 * Captured endpoints:
 *   1. GET  /api/pick/orders/missed/count     → Missed order count
 *   2. GET  /api/pick/cpts/recommended        → Date cards (CPT slots)
 *   3. GET  /api/pick/lists/recommended?...   → Create tab pick lists
 *   4. POST /api/graphql (PickTasksByFilter)   → Active tab pick tasks
 */

class ApiInterceptor {
  constructor(page) {
    this.page = page;
    
    // Captured data stores
    this._missedCount = null;
    this._dateCards = null;
    this._createTabLists = null;
    this._activeTabLists = null;
    
    // Promise resolvers for waiting
    this._resolvers = {};
    this._promises = {};
    
    // Create promises for each data source
    ['missedCount', 'dateCards', 'createTabLists', 'activeTabLists'].forEach(key => {
      this._promises[key] = new Promise(resolve => {
        this._resolvers[key] = resolve;
      });
    });
    
    this._setupListeners();
  }

  _setupListeners() {
    this.page.on('response', async (response) => {
      const url = response.url();
      const request = response.request();

      try {
        // 1. Missed order count
        if (url.includes('/api/pick/orders/missed/count')) {
          const text = await response.text();
          this._missedCount = parseInt(text, 10) || 0;
          console.log(`[API Interceptor] Captured missed count: ${this._missedCount}`);
          this._resolvers.missedCount(this._missedCount);
          return;
        }

        // 2. Date cards (CPT recommended)
        if (url.includes('/api/pick/cpts/recommended') && !url.includes('lists')) {
          const data = await this._parseJsonResponse(response);
          if (data) {
            this._dateCards = data;
            console.log(`[API Interceptor] Captured ${data.length} date cards`);
            this._resolvers.dateCards(data);
          }
          return;
        }

        // 3. Create tab pick lists
        if (url.includes('/api/pick/lists/recommended')) {
          const data = await this._parseJsonResponse(response);
          if (data) {
            this._createTabLists = data;
            console.log(`[API Interceptor] Captured ${data.length} create tab pick lists`);
            this._resolvers.createTabLists(data);
          }
          return;
        }

        // 4. GraphQL — Active tab (PickTasksByFilter)
        if (url.includes('/api/graphql') && request.method() === 'POST') {
          // Check if this is the PickTasksByFilter query
          let postData = null;
          try {
            const postText = request.postData();
            if (postText) postData = JSON.parse(postText);
          } catch {}
          
          if (postData && postData.query && postData.query.includes('PickTasksByFilter')) {
            const data = await this._parseJsonResponse(response);
            if (data && data.data && data.data.pickTasksByFilter) {
              this._activeTabLists = data.data.pickTasksByFilter;
              console.log(`[API Interceptor] Captured ${this._activeTabLists.length} active tab pick tasks`);
              this._resolvers.activeTabLists(this._activeTabLists);
            }
          }
          return;
        }
      } catch (err) {
        // Silently ignore errors from reading responses (preflight, redirects, etc.)
      }
    });
  }

  /**
   * Parse a JSON response body, handling cases where content-type
   * header is missing (e.g. GraphQL responses from SmartHUB)
   */
  async _parseJsonResponse(response) {
    try {
      const contentType = (await response.allHeaders())['content-type'] || '';
      
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      
      // Fallback: try parsing text as JSON (GraphQL responses often lack content-type)
      const text = await response.text();
      if (text && (text.trim().startsWith('{') || text.trim().startsWith('['))) {
        return JSON.parse(text);
      }
      
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Wait for Create tab data (missed count + date cards + pick lists)
   * These fire automatically on page navigation to /pick
   */
  async waitForCreateTabData(timeoutMs = 15000) {
    const timeout = (label) => new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`[API Interceptor] Timeout waiting for ${label}`)), timeoutMs)
    );

    const results = {};
    
    try {
      results.missedCount = await Promise.race([this._promises.missedCount, timeout('missedCount')]);
    } catch (err) {
      console.warn(err.message);
      results.missedCount = null;
    }

    try {
      results.dateCards = await Promise.race([this._promises.dateCards, timeout('dateCards')]);
    } catch (err) {
      console.warn(err.message);
      results.dateCards = null;
    }

    try {
      results.createTabLists = await Promise.race([this._promises.createTabLists, timeout('createTabLists')]);
    } catch (err) {
      console.warn(err.message);
      results.createTabLists = null;
    }

    return results;
  }

  /**
   * Wait for Active tab data (GraphQL PickTasksByFilter)
   * This fires after clicking the "Active pick lists" tab
   */
  async waitForActiveTabData(timeoutMs = 15000) {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('[API Interceptor] Timeout waiting for activeTabLists')), timeoutMs)
    );

    try {
      return await Promise.race([this._promises.activeTabLists, timeout]);
    } catch (err) {
      console.warn(err.message);
      return null;
    }
  }

  /**
   * Get all captured data (call after both tabs have been visited)
   */
  getData() {
    return {
      missedCount: this._missedCount,
      dateCards: this._dateCards,
      createTabLists: this._createTabLists,
      activeTabLists: this._activeTabLists
    };
  }

  /**
   * Check if any meaningful API data was captured
   */
  hasData() {
    return this._createTabLists !== null || this._activeTabLists !== null;
  }
}

module.exports = { ApiInterceptor };
