"""Generate synthetic local QA workbooks. Requires XlsxWriter 3.x; no user data or network."""
from pathlib import Path
import io, zlib, struct
import xlsxwriter

out = Path('.codex-artifacts/sheet-complete-20261101')
out.mkdir(parents=True, exist_ok=True)
p = out / '表格完整验收.xlsx'
w = xlsxwriter.Workbook(p)
base = {'font_name':'Calibri','font_size':11,'border':1,'border_color':'#D9DFE7','valign':'vcenter'}
head = w.add_format({**base,'bold':True,'font_color':'#FFFFFF','bg_color':'#16324F'})
text = w.add_format(base)
num = w.add_format({**base,'num_format':'#,##0.00'})
title = w.add_format({'font_name':'Calibri','font_size':20,'bold':True,'font_color':'#16324F'})
s = w.add_worksheet('概览与条件格式')
s.set_column('A:A',15); s.set_column('B:D',13); s.set_column('E:H',15)
s.merge_range('A1:D1','季度交付 · 格式验收',title); s.set_row(0,32)
s.write_row('A3',['项目','完成率','收入','趋势'],head)
for i, v in enumerate([15,45,70,92,55,100],3):
    s.write(i,0,f'项目 {i-2}',text); s.write(i,1,v,text); s.write(i,2,(i+1)*1234.56,num); s.set_row(i,27)
    s.write_row(i,8,[i*2,i*3,i*2+1,i*4])
    s.add_sparkline(i,3,{'range':f'I{i+1}:L{i+1}','series_color':'#387EED','markers':True})
s.conditional_format('B4:B9',{'type':'data_bar','bar_color':'#387EED','bar_solid':True})
s.conditional_format('C4:C9',{'type':'3_color_scale'})
s.write('A11','状态图标',head)
for i,v in enumerate([10,50,90],11): s.write(i,0,v,text)
s.conditional_format('A12:A14',{'type':'icon_set','icon_style':'3_traffic_lights'})
s.write('B11','公式规则',head)
for i,v in enumerate([12,75,95],11): s.write(i,1,v,text)
s.conditional_format('B12:B14',{'type':'formula','criteria':'=B12>70','format':w.add_format({'bold':True,'font_color':'#006100','bg_color':'#C6EFCE'})})
s.write('A16','已保存公式',head); s.write_formula('B16','=SUM(C4:C9)',num,sum((i+1)*1234.56 for i in range(3,9)))
s.write('A17','缓存优先',head); s.write_formula('B17','=1+1',text,41)
s.write('A18','日期',head); s.write_number('B18',44562,w.add_format({**base,'num_format':'yyyy-mm-dd'}))
s.write('A20','富文本',head); s.write_rich_string('B20',w.add_format({'bold':True,'font_color':'#387EED'}),'重点', ' 内容',text)
s.freeze_panes(3,1)
s.set_column('I:L',10,None,{'hidden':True})
s.set_row(20,None,None,{'hidden':True}); s.write('A21','隐藏内容')
s.insert_textbox('F14','嵌入形状\n格式与层次均保留',{'width':205,'height':75,'font':{'name':'Calibri','color':'#16324F'},'fill':{'color':'#E8F0FE'},'line':{'color':'#387EED'}})
# Tiny generated PNG, fully synthetic; no external fonts/assets.
def chunk(t,d): return struct.pack('!I',len(d))+t+d+struct.pack('!I',zlib.crc32(t+d)&0xffffffff)
raw=b''.join(b'\x00'+bytes([56,126,237,255])*48 for _ in range(28))
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',48,28,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
s.insert_image('F11','synthetic.png',{'image_data':io.BytesIO(png),'x_scale':3,'y_scale':2})
c = w.add_chart({'type':'column'}); c.add_series({'name':'收入','categories':"='概览与条件格式'!$A$4:$A$9",'values':"='概览与条件格式'!$C$4:$C$9",'fill':{'color':'#387EED'}});c.set_title({'name':'交付收入'});c.set_legend({'none':True});c.set_size({'width':375,'height':225});s.insert_chart('F1',c)
# Real OOXML charts rather than pictures of charts.
for kind in ['column','bar','line','area','pie','doughnut','scatter','radar','stock']:
    sh=w.add_worksheet(kind); sh.set_column('A:D',12);sh.write_row('A1',['项目','指标一','指标二','指标三'],head)
    for i in range(1,7): sh.write_row(i,0,[i,10+i*3,16+i*4,22+i*4],text)
    ch=w.add_chart({'type':kind})
    for col in range(1,4) if kind=='stock' else range(1,2 if kind in ['pie','doughnut','scatter'] else 3):
        ch.add_series({'name':[kind,0,col],'categories':[kind,1,0,6,0],'values':[kind,1,col,6,col]})
    ch.set_title({'name':kind+' 图表'});ch.set_style(10); sh.insert_chart('F2',ch,{'x_scale':1.2,'y_scale':1.2})
t=w.add_worksheet('表格与合并');t.set_column('A:D',18); t.merge_range('A1:D2','表格主题、自动筛选与合并',title)
t.add_table('A4:D10',{'name':'Delivery','columns':[{'header':'名称'},{'header':'数量'},{'header':'单价'},{'header':'备注'}], 'data':[[f'产品 {i}',i*3,i*95,'自动换行与主题'] for i in range(1,7)],'style':'Table Style Medium 2'})
t.freeze_panes(4,1)
empty=w.add_worksheet('空表');empty.write('A1','')
h=w.add_worksheet('不显示的隐藏表');h.write('A1','隐藏工作表');h.hide()
w.close()
print(p.resolve())
