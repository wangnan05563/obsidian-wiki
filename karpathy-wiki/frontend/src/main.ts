import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import TipPlugin, { vTip } from './directives/tip';
import './style.css';
// 主题 Token 语义层（FR-24）：--tk-* 映射桥 + dark 整体覆盖。
// 必须在 themes/index.css 之前导入：主题文件与 :root 桥特异性相同，
// 后导入者胜出，主题覆盖桥值才生效
import './styles/tokens.css';
// 主题系统：在 style.css 之后导入，确保主题覆盖生效
import './styles/themes/index.css';
// 移动端浅白极简主题（仅作用于 .mobile-root 子树，不影响桌面 aurora 主题）
import './styles/mobile-light.css';
// 统一弹窗交互规范（对话框 / 抽屉 / 确认框共用一套遮罩、动效、容器样式）
import './styles/modal.css';

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus);
app.use(TipPlugin); // 全局按钮悬浮提示（统一 tooltip）
app.directive('tip', vTip); // 可选：v-tip="'说明'" 等价于写入 data-tip
app.mount('#app');
