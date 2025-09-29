// functions/api/[[path]].js (Pages Functions 檔案)

// ----------------------------------------------------------------------
// 這是 Pages Functions 的後端邏輯。
// 它會取代您之前獨立部署的 Worker。
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// A. 處理 CORS 和 Headers
// ----------------------------------------------------------------------
// 因為是 Pages Functions，所以 CORS 已經簡化，通常 Pages 會自動處理，
// 但這裡我們手動加上通用的頭，確保跨域呼叫（如果有的話）正常。
function getCorsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*', 
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json' 
    };
}


// ----------------------------------------------------------------------
// B. 數據處理函數 (請將您 worker.js 裡面的函數全部貼在這裡)
// ----------------------------------------------------------------------

/** 獲取所有學生資料 (包含 tasks 和 comments) */
async function handleGetStudents(env) {
    // 獲取所有學生基本資料
    const { results: studentsData } = await env.DB.prepare(
        "SELECT account, name, school, class, email FROM students"
    ).all();

    // 獲取所有任務資料
    const { results: tasksData } = await env.DB.prepare(
        "SELECT id, student_account, name, status, teacher_comment FROM tasks"
    ).all();

    // 獲取所有留言資料
    const { results: commentsData } = await env.DB.prepare(
        "SELECT id, task_id, sender, content, timestamp, is_recalled, is_blocked FROM comments"
    ).all();

    // 整理留言數據 (依 task_id 分組)
    const commentsMap = commentsData.reduce((acc, comment) => {
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
    const studentsMap = studentsData.reduce((acc, student) => {
        acc[student.account] = { 
            ...student, 
            tasks: [] 
        };
        return acc;
    }, {});

    tasksData.forEach(task => {
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

    return new Response(JSON.stringify(studentsMap), { status: 200, headers: getCorsHeaders() });
}

/** 新增或更新單個學生資料及其所有任務 (POST/PUT /api/students) */
async function handleSaveStudent(request, env) {
    const data = await request.json();
    const { account, name, school, class: cls, email, tasks } = data;

    if (!account || !name) {
        return new Response(JSON.stringify({ error: "學號和姓名為必填欄位。" }), { status: 400, headers: getCorsHeaders() });
    }

    // D1 批次操作列表
    const statements = [];

    // 1. 學生基本資料：INSERT OR REPLACE
    statements.push(
        env.DB.prepare(
            "INSERT OR REPLACE INTO students (account, name, school, class, email) VALUES (?, ?, ?, ?, ?)",
            [account, name, school, cls, email]
        )
    );
    
    // 2. 刪除該學號舊有任務 (CASCADE DELETE 會自動刪除相關留言)
    statements.push(
        env.DB.prepare(
            "DELETE FROM tasks WHERE student_account = ?", [account]
        )
    );

    // 3. 插入新的任務清單
    (tasks || []).forEach(task => {
        const taskId = parseInt(task.id);
        if (taskId) {
            statements.push(
                env.DB.prepare(
                    "INSERT INTO tasks (id, student_account, name, status, teacher_comment) VALUES (?, ?, ?, ?, ?)",
                    [taskId, account, task.name, task.status, task.teacherComment]
                )
            );
        }
    });

    try {
        await env.DB.batch(statements);
        return new Response(JSON.stringify({ message: "學生資料更新成功" }), { status: 200, headers: getCorsHeaders() });
    } catch (e) {
        console.error("Save Student Error:", e.stack);
        return new Response(JSON.stringify({ error: `資料庫操作失敗: ${e.message}` }), { status: 500, headers: getCorsHeaders() });
    }
}

/** 刪除單個學生資料 (DELETE /api/students) */
async function handleDeleteStudent(request, env) {
    const { account } = await request.json();

    if (!account) {
        return new Response(JSON.stringify({ error: "缺少學號。" }), { status: 400, headers: getCorsHeaders() });
    }

    try {
        const result = await env.DB.prepare("DELETE FROM students WHERE account = ?").bind(account).run();

        if (result.changes === 0) {
            return new Response(JSON.stringify({ error: "查無此學號或資料已刪除。" }), { status: 404, headers: getCorsHeaders() });
        }
        return new Response(JSON.stringify({ message: `學號 ${account} 資料已刪除。` }), { status: 200, headers: getCorsHeaders() });
    } catch (e) {
        console.error("Delete Student Error:", e.stack);
        return new Response(JSON.stringify({ error: `刪除失敗: ${e.message}` }), { status: 500, headers: getCorsHeaders() });
    }
}

/** 處理學生登入查詢 (POST /api/student-login) */
async function handleStudentLogin(request, env) {
    const { school, class: cls, account } = await request.json();

    // 查詢學生基本資料
    const { results: studentsData } = await env.DB.prepare(
        "SELECT account, name, school, class, email FROM students WHERE school = ? AND class = ? AND account = ?"
    )
    .bind(school, cls, account)
    .all();

    if (!studentsData || studentsData.length === 0) {
        return new Response(JSON.stringify({ error: "查無此學生。" }), { status: 404, headers: getCorsHeaders() });
    }

    const student = studentsData[0];
    const studentAccount = student.account;
    
    // 查找該學生的任務
    const { results: tasksData } = await env.DB.prepare(
        "SELECT id, student_account, name, status, teacher_comment FROM tasks WHERE student_account = ?"
    ).bind(studentAccount).all();
    
    // 獲取所有相關的留言資料
    const taskIds = tasksData.map(t => t.id).join(',');
    let commentsData = [];
    if (taskIds) {
        const commentsQuery = `SELECT id, task_id, sender, content, timestamp, is_recalled, is_blocked FROM comments WHERE task_id IN (${taskIds})`;
         const { results } = await env.DB.prepare(commentsQuery).all();
         commentsData = results;
    }

    const commentsMap = commentsData.reduce((acc, comment) => {
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
    
    student.tasks = [];
    tasksData.forEach(task => {
        student.tasks.push({
            id: task.id,
            name: task.name,
            status: task.status,
            teacherComment: task.teacher_comment,
            comments: commentsMap[task.id] || []
        });
    });

    return new Response(JSON.stringify(student), { status: 200, headers: getCorsHeaders() });
}


/** 留言操作 (POST /api/comment) */
async function handleComment(request, env) {
    const data = await request.json();
    const { action, task_id, sender, content, timestamp, comment_id } = data;
    
    if (!action) {
         return new Response(JSON.stringify({ error: "缺少 action 參數" }), { status: 400, headers: getCorsHeaders() });
    }

    try {
        let stmt;

        if (action === 'ADD') {
            if (!task_id || !sender || !content || !timestamp) throw new Error("缺少新增留言的必要參數");

            stmt = env.DB.prepare(
                "INSERT INTO comments (task_id, sender, content, timestamp) VALUES (?, ?, ?, ?)",
                [task_id, sender, content, timestamp]
            );

        } else if (action === 'RECALL' || action === 'BLOCK') {
            if (!comment_id) throw new Error(`缺少 ${action} 留言的 ID`);

            const column = action === 'RECALL' ? 'is_recalled' : 'is_blocked';
            
            stmt = env.DB.prepare(
                `UPDATE comments SET ${column} = 1 WHERE id = ?`,
                [comment_id]
            );
        } else {
            return new Response(JSON.stringify({ error: "無效的 action" }), { status: 400, headers: getCorsHeaders() });
        }

        const result = await stmt.run();
        
        return new Response(JSON.stringify({ 
            message: "操作成功", 
            commentId: action === 'ADD' ? result.meta.last_row_id : comment_id 
        }), { status: 200, headers: getCorsHeaders() });

    } catch (error) {
        console.error("Comment API Error:", error.stack);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: getCorsHeaders() });
    }
}


// ----------------------------------------------------------------------
// C. Pages Functions 路由入口
// ----------------------------------------------------------------------

export async function onRequest(context) {
    const { request, env, params } = context;
    
    // 處理 OPTIONS 請求
    if (request.method === 'OPTIONS') {
         return new Response(null, { headers: getCorsHeaders() });
    }
    
    // params.path[0] 會是 Pages Functions 路由中的第一個萬用字元
    const apiPath = params.path[0]; // 例如：'students', 'student-login', 'comment'

    try {
        let response;
        
        // 路由邏輯 (根據 apiPath 和 method 呼叫對應的處理函數)
        if (apiPath === 'students') {
            if (request.method === 'GET') {
                response = await handleGetStudents(env);
            } else if (request.method === 'POST' || request.method === 'PUT') {
                response = await handleSaveStudent(request, env);
            } else if (request.method === 'DELETE') {
                response = await handleDeleteStudent(request, env);
            }
        } else if (apiPath === 'student-login' && request.method === 'POST') {
            response = await handleStudentLogin(request, env);
        } else if (apiPath === 'comment' && request.method === 'POST') {
            response = await handleComment(request, env);
        } else {
            response = new Response(JSON.stringify({ error: 'API Path Not Found' }), { status: 404, headers: getCorsHeaders() });
        }

        return response;

    } catch (e) {
        console.error("Pages Function Global Error:", e.stack);
        return new Response(JSON.stringify({ error: e.message || "Internal Server Error" }), { status: 500, headers: getCorsHeaders() });
    }
}
