// FloatingChat 组件可配置参数集中管理。
// 为什么需要：标题、建议问题、尺寸等参数散落在模板中属于硬编码，
//   集中后修改只需改一处，且便于后续从后端 API 动态拉取或国际化扩展。
//
// 约束：仅声明非敏感 UI 配置；apiKey 等敏感字段不在此处。
// 默认配置：所有可变参数单一可信源
export const FLOATING_CHAT_CONFIG = {
    panelTitle: 'AI 知识库问答',
    suggestionQuestions: [
        '什么是 RAG？',
        'Embedding 是什么？',
        'Vector Database 的作用',
    ],
    floatButtonSize: 56,
    panel: {
        width: 420,
        minHeight: 360,
        maxHeight: 560,
    },
    position: {
        bottom: 24,
        right: 24,
        queryPageLeft: 24,
    },
    textarea: {
        minRows: 1,
        maxRows: 6,
    },
    shortcuts: {
        close: 'Escape',
    },
};
