// 让 TypeScript 识别 .vue 单文件组件
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

// 扩展 input 标签属性以支持 webkitdirectory / directory
// 为什么需要：webkitdirectory 是非标准属性，TypeScript 内置 HTMLAttributes 未声明
// 仅用于 Ingest.vue 文件夹上传场景，作用域全局 input 标签
interface HTMLAttributes {
  webkitdirectory?: boolean;
  directory?: boolean;
}
