from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.goto("http://localhost:3000/")
    page.wait_for_timeout(1800)
    page.locator("input").nth(0).fill("admin")
    page.locator("input[type=password]").first.fill("admin123")
    page.get_by_text("登 录", exact=True).click()
    page.wait_for_timeout(2500)

    info = page.evaluate(
        """() => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl.__vue_app__.config.globalProperties.$pinia;
          return {
            storeIds: Array.from(pinia._s.keys()),
            hasConv: pinia._s.has('conversations')
          };
        }"""
    )
    print(info)
    b.close()
