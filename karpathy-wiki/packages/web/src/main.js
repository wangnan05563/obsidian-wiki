import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import './style.css';
// 主题系统：在 style.css 之后导入，确保主题覆盖生效
import './styles/themes/index.css';
const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus);
app.mount('#app');
