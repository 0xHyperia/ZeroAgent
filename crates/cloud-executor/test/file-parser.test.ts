import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileParser } from "../src/file-broker.ts";

const executable = process.platform === "win32" ? "wsl.exe" : "python3";
const prefix = process.platform === "win32" ? ["-d", "Ubuntu", "--", "python3"] : [];
const dependencies = process.env.ZEROAGENT_PARSER_TEST_DEPS_DIR ?? "";
const probe =
  "import sys;sys.path.insert(0,sys.argv[1]);import pypdf,defusedxml;assert pypdf.__version__=='6.21.4' and defusedxml.__version__=='0.7.1'";
const available =
  spawnSync(executable, [...prefix, "-c", probe, dependencies], {
    timeout: 10_000,
    windowsHide: true,
  }).status === 0;
const harness = String.raw`
import base64,hashlib,io,json,os,pathlib,subprocess,sys,tempfile,zipfile
source=base64.b64decode(sys.argv[1]).decode();deps=sys.argv[2];sys.path.insert(0,deps)
from pypdf import PdfWriter
from pypdf.generic import NameObject,DictionaryObject,DecodedStreamObject
entry='import sys;sys.path.insert(0,'+repr(deps)+');exec(compile('+repr(source)+',"file_parser.py","exec"))'
with tempfile.TemporaryDirectory(prefix='zeroagent-parser-fixture-') as td:
 root=pathlib.Path(td)
 def parse(name,data,kind,expected_error=None):
  path=root/name;path.write_bytes(data)
  payload={'root':str(root),'path':name,'output_path':'derived/'+name+'.json','format':kind,'source_sha256':hashlib.sha256(data).hexdigest(),'scope':'opaque-test-scope','sandbox_id':'owned-test-vm'}
  response=subprocess.run([sys.executable,'-I','-c',entry],input=json.dumps(payload),capture_output=True,text=True,timeout=50)
  assert response.returncode==0,response.stderr
  result=json.loads(response.stdout)
  if expected_error:
   assert result.get('error')==expected_error,result
   return result
  assert 'error' not in result,result
  encoded=(root/result['output_path']).read_bytes();assert len(encoded)<=2097152 and hashlib.sha256(encoded).hexdigest()==result['sha256']
  document=json.loads(encoded);assert document['scope']=='opaque-test-scope' and document['sandbox_id']=='owned-test-vm'
  return document
 def archive(entries,compressed=False):
  output=io.BytesIO()
  with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED if compressed else zipfile.ZIP_STORED) as z:
   for name,data in entries.items(): z.writestr(name,data)
  return output.getvalue()
 writer=PdfWriter();page=writer.add_blank_page(width=100,height=100)
 font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
 page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
 content=DecodedStreamObject();content.set_data(b'BT /F1 12 Tf 10 10 Td (Hello PDF) Tj ET');page[NameObject('/Contents')]=writer._add_object(content)
 output=io.BytesIO();writer.write(output)
 pdf=parse('test.pdf',output.getvalue(),'pdf');assert 'Hello PDF' in pdf['segments'][0]['text'] and pdf['segments'][0]['locator']['page']==1
 docx=archive({'word/document.xml':'<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>'})
 doc=parse('test.docx',docx,'docx');assert doc['segments'][1]['locator']['paragraph']==2
 xlsx=archive({'xl/workbook.xml':'<workbook xmlns:r="rel"><sheets><sheet name="Budget" r:id="r1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Hello XLSX</t></is></c><c r="B2"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>'})
 sheet=parse('test.xlsx',xlsx,'xlsx');assert sheet['segments'][0]['locator']['cell']=='A1' and sheet['segments'][0]['locator']['sheet']=='Budget' and sheet['segments'][1]['text']=='3'
 pptx=archive({'ppt/presentation.xml':'<presentation xmlns:r="rel"><sldIdLst><sldId r:id="r1"/></sldIdLst></presentation>',
  'ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="r1" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide2.xml':'<slide><p><t>Hello PPTX</t></p></slide>'})
 slide=parse('test.pptx',pptx,'pptx');assert slide['segments'][0]['locator']['slide']==1 and slide['segments'][0]['text']=='Hello PPTX'
 bomb=archive({'word/document.xml':'x'*(9*1024*1024)},True);parse('bomb.docx',bomb,'docx','zip_expansion_limit')
 xxe=archive({'word/document.xml':'<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]><document>&ext;</document>'});parse('xxe.docx',xxe,'docx','parse_failed')
 bigdoc=archive({'word/document.xml':'<document><p><t>'+('x'*(2*1024*1024))+'</t></p></document>'})
 truncated=parse('truncated.docx',bigdoc,'docx');assert truncated['truncated'] is True and len(truncated['segments'])<5000
 too_many=PdfWriter()
 for _ in range(201):too_many.add_blank_page(width=10,height=10)
 output=io.BytesIO();too_many.write(output);parse('many.pdf',output.getvalue(),'pdf','page_limit')
 unsafe=archive({'../escape.xml':'bad','word/document.xml':'<document/>'});parse('unsafe.docx',unsafe,'docx','unsafe_archive')
 print('isolated PDF DOCX XLSX PPTX bounded extraction: PASS')
`;
test("isolated Linux parser extracts real PDF and OOXML fixtures with locators, limits and partial-output marker", {
  skip: !available,
}, () => {
  const output = execFileSync(
    executable,
    [...prefix, "-c", harness, Buffer.from(fileParser).toString("base64"), dependencies],
    { timeout: 60_000, windowsHide: true, encoding: "utf8" },
  );
  assert.match(output, /isolated PDF DOCX XLSX PPTX bounded extraction: PASS/);
});
