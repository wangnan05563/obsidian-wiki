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
          const res = {};
          const all = Array.from(document.querySelectorAll('*'));
          const adminEl = all.find(e => e.children.length === 0 && e.textContent.trim() === 'admin');
          res.adminElClass = adminEl ? adminEl.className : 'not found';
          res.adminElParentClass = adminEl ? adminEl.parentElement.className : '';
          res.logoutTexts = all.filter(e => e.children.length === 0 && /退出|登出|切换/.test(e.textContent)).map(e => e.textContent.trim());
          res.dropdownTriggers = Array.from(document.querySelectorAll('.el-dropdown, [class*=dropdown], [class*=avatar]')).map(e => e.className.toString().slice(0,50)).slice(0,10);
          return res;
        }"""
    )
    print(info)
    b.close()
