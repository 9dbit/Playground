from pathlib import Path
p=Path('tests/security.integration.test.js')
s=p.read_text()
a="""    await request('/api/admin/settings/general','PUT',{value:{site_title:'QA',private_marker:'never-return-to-viewer'}},owner);
    await request('/api/admin/settings/notification','PUT',{value:{private_marker:'never-return-to-viewer'}},owner);"""
b="""    const invalid=await request('/api/admin/settings/general','PUT',{value:{site_title:'QA',private_marker:'never-return-to-viewer'},expected_version:0},owner);
    assert.equal(invalid.status,400,'Unknown settings fields must be rejected');
    const general=await request('/api/admin/settings/general','PUT',{value:{site_title:'QA',register_bonus:7},expected_version:0},owner);
    assert.equal(general.status,200,JSON.stringify(general.data));
    const notification=await request('/api/admin/settings/notification','PUT',{value:{sender:'never-return-to-viewer'},expected_version:0},owner);
    assert.equal(notification.status,200,JSON.stringify(notification.data));"""
assert s.count(a)==1,'Security settings fixture changed unexpectedly'
s=s.replace(a,b)
a="    assert.equal(q.data.items[0].value.site_title,'QA');"
b=a+"\n    assert.equal(q.data.items[0].value.register_bonus,undefined);\n    assert.equal(q.data.items.some(item=>item.key==='notification'),false);"
assert s.count(a)==1
p.write_text(s.replace(a,b))
