"""Test account-switch: does logging out of admin and into user actually update auth.user?"""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def read_auth(page):
    return page.evaluate(
        """() => {
          const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
          const pinia = appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
          const auth = pinia._s.get('auth');
          return { username: auth && auth.user ? auth.user.username : 'NULL', uid: auth && auth.user ? auth.user.id.slice(0,8) : 'NULL', loggedIn: auth && auth.isLoggedIn };
        }"""
    )


def login(page, username, password):
    page.goto(BASE + "/")
    page.wait_for_timeout(1800)
    if page.locator("text=请登录以继续").count() > 0:
        page.locator("input").nth(0).fill(username)
        page.locator("input[type=password]").first.fill(password)
        page.get_by_text("登 录", exact=True).click()
        page.wait_for_timeout(2500)
    return read_auth(page)


def try_logout(page):
    # click avatar/user chip
    for sel in [".user-chip", "header .avatar", "[class*=avatar]", ".el-dropdown", "[class*=user]"]:
        try:
            page.locator(sel).first.click(timeout=2000)
            page.wait_for_timeout(600)
            break
        except Exception:
            continue
    for lbl in ["退出登录", "退出", "登出", "Logout", "切换账户"]:
        try:
            page.get_by_text(lbl, exact=False).first.click(timeout=2500)
            page.wait_for_timeout(2000)
            return True
        except Exception:
            continue
    return False


def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        out["after_admin_login"] = login(page, "admin", "admin123")
        out["logout_clicked"] = try_logout(page)
        out["after_logout_auth"] = read_auth(page)
        out["after_user_login"] = login(page, "user", "user123")
        b.close()
    print(__import__("json").dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
