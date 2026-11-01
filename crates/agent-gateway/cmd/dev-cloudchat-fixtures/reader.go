package main

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"

	"github.com/liveagent/agent-gateway/internal/account"
)

const readerProjectKey = "reader-showcase-v1:project"

// Reuse verified account originals; no fake preview URLs, uploads or model runs.
func buildReaderFixtures(user int64, refs []fileReference, samples string) ([]fixturePlan, []fileReference, error) {
	used := []fileReference{}
	plans := []fixturePlan{}
	intro, err := buildFixture(user, fixture{Key: "reader-showcase-v1:guide", Title: "合成验收数据 · 00 验收指南", Turns: []fixtureTurn{simpleTurn("这是专门的本地验收项目，所有文件都是合成样例。", "## 资料与阅读验收\n\n从项目会话列表选择文件类型，点击消息里的附件即可预览。\n\n- Word / PDF：目录、平滑跳转、缩放、批注及浮动工具。\n- PPT / Excel：翻页、工作表、单元格定位。\n- 图片 / Markdown / 音视频 / ZIP：格式专属预览。\n- 损坏、空文本和长名称：失败恢复与边界排版。\n- 成果保留与站点版本：历史时间轴、恢复、私有站点。\n- 待发送队列、服务端草稿：刷新和会话切换后保留。\n\n拖拽测试可使用本地验收样本文件，添加后不会自动发送。本项目的预置过程不代表真实模型或 E2B 执行；真实发送仍走正常服务。")}}, -10)
	if err != nil {
		return nil, nil, err
	}
	plans = append(plans, intro)
	for index, ref := range refs {
		if strings.Contains(ref.Name, "回收站") {
			continue
		}
		ext := strings.ToLower(filepath.Ext(ref.Name))
		task := map[string]string{".docx": "Word：目录、缩略图、批注与缩放", ".pdf": "PDF：连续纸张与页码导航", ".pptx": "PPT：翻页与适合窗口", ".xlsx": "表格：多工作表与单元格定位", ".csv": "CSV：表格阅读", ".md": "Markdown：正文、目录与代码", ".png": "图片：缩放与下载", ".webp": "WebP 图片", ".gif": "动图", ".bmp": "位图", ".avif": "AVIF 图片", ".wav": "音频播放", ".mp4": "视频播放", ".zip": "压缩包目录", ".json": "JSON：源码阅读", ".txt": "文本：空内容与长名称"}[ext]
		if task == "" {
			continue
		}
		turn := simpleTurn("合成验收数据："+ref.Name, "点击上方附件查看 **"+task+"**。\n\n可保留当前草稿切换预览，再返回本会话。文档可进入请求修改模式并添加批注；点击发送前不会调用模型。故意损坏的文件应显示清楚的失败提示，并保留重试和下载原件。")
		turn.References = []fileReference{ref}
		plan, e := buildFixture(user, fixture{Key: "reader-showcase-v1:file:" + ref.FileID, Title: "合成验收数据 · " + strings.TrimSuffix(ref.Name, filepath.Ext(ref.Name)), Turns: []fixtureTurn{turn}}, -11-index)
		if e != nil {
			return nil, nil, e
		}
		plans = append(plans, plan)
		used = append(used, ref)
	}
	if len(used) == 0 {
		return nil, nil, errors.New("reader profile requires existing account-owned sample files")
	}
	extra, err := buildCompleteFixtures(user, used, samples, "reader-showcase-v1:")
	if err != nil {
		return nil, nil, err
	}
	plans = append(plans, extra...)
	for index := range plans {
		plans[index].ProjectID = stableID(user, readerProjectKey)
		plans[index].Fingerprint = ""
		plans[index].Fingerprint = digest(encoded(plans[index]))
	}
	return plans, used, nil
}

func prepareReaderProject(ctx context.Context, tx *sql.Tx, user int64, plans []fixturePlan, previous map[string]bool) (bool, error) {
	if len(plans) == 0 || plans[0].ProjectID == "" {
		return true, nil
	}
	id := stableID(user, readerProjectKey)
	for _, plan := range plans {
		if plan.ProjectID != id {
			return false, errors.New("invalid reader project identity")
		}
	}
	var owner int64
	err := tx.QueryRowContext(ctx, `SELECT user_id FROM zeroagent_cloud_projects WHERE id=$1`, id).Scan(&owner)
	if err == nil {
		if owner != user {
			return false, errors.New("reader project belongs to another account")
		}
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	// A deleted project is a user decision, like a deleted fixture conversation.
	if len(previous) > 0 {
		return false, nil
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_cloud_projects:'||$1::text,0))`, user); err != nil {
		return false, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_projects WHERE user_id=$1`, user).Scan(&count); err != nil {
		return false, err
	}
	if count >= account.CloudProjectMaxAccountProjects {
		return false, errors.New("project quota reached")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_projects(id,user_id,name,description,instructions,icon,color) VALUES($1,$2,'验收','本地开发验收，全部为合成样例；不含真实客户资料。','','folder','blue')`, id, user)
	return err == nil, err
}
