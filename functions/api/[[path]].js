/** 獲取所有學生資料 (包含 tasks 和 comments) */
async function handleGetStudents(env) {
    try {
        // 1. 獲取所有學生基本資料
        const { results: studentsData } = await env.DB.prepare(
            "SELECT account, name, school, class, email FROM students"
        ).all();

        // 2. 獲取所有任務資料
        const { results: tasksData } = await env.DB.prepare(
            "SELECT id, student_account, name, status, teacher_comment FROM tasks"
        ).all();

        // 3. 獲取所有留言資料
        const { results: commentsData } = await env.DB.prepare(
            "SELECT id, task_id, sender, content, timestamp, is_recalled, is_blocked FROM comments"
        ).all();

        // 初始化結果並檢查數據是否存在
        const safeStudentsData = studentsData || [];
        const safeTasksData = tasksData || [];
        const safeCommentsData = commentsData || [];

        // 整理留言數據 (依 task_id 分組)
        const commentsMap = safeCommentsData.reduce((acc, comment) => {
            if (!acc[comment.task_id]) acc[comment.task_id] = [];
            acc[comment.task_id].push({
                id: comment.id,
                sender: comment.sender,
                content: comment.content,
                timestamp: comment.timestamp,
                isRecalled: comment.is_recalled === 1,
                isBlocked: comment.is_blocked === 1,
            });
            return acc;
        }, {});

        // 整理學生和任務數據
        const studentsMap = safeStudentsData.reduce((acc, student) => {
            acc[student.account] = { 
                ...student, 
                tasks: [] 
            };
            return acc;
        }, {});

        safeTasksData.forEach(task => {
            const student = studentsMap[task.student_account];
            if (student) {
                student.tasks.push({
                    id: task.id,
                    name: task.name,
                    status: task.status,
                    teacherComment: task.teacher_comment,
                    comments: commentsMap[task.id] || []
                });
            }
        });

        // 確保返回 Response 物件，並將學生資料作為 JSON 響應
        return new Response(JSON.stringify(studentsMap), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
        });

    } catch (e) {
        console.error("handleGetStudents Error:", e.stack || e);
        // 如果發生任何錯誤，返回一個明確的 500 錯誤 JSON 響應
        return new Response(JSON.stringify({ error: "資料庫讀取失敗: " + (e.message || "未知錯誤") }), { 
            status: 500, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}
