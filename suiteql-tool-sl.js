/**
* @NApiVersion 2.1
* @NScriptType Suitelet
* @NModuleScope Public
* @Authors Mosses
* @Version 2025.6_Moss_Stable
* @Changelog
* - 2025.6-Moss_Stable-DML-Safety: Client side regex now detects DROP/TRUNCATE. Server side parser now explicitly blocks DROP/TRUNCATE with a helpful error message.
* - 2025.5-Moss_Stable-Create-Parser: Added client side detection for `CREATE`. Added server side `executeCreate` function to parse `CREATE.. SET...` syntax and use `record.create`.
*/

var file, https, log, query, record, render, runtime, scriptURL, url;
var datatablesEnabled = true,
	remoteLibraryEnabled = true,
	rowsReturnedDefault = 50,
	queryFolderID = null,
	workbooksEnabled = false;
const Modules = ['N/file', 'N/https', 'N/log', 'N/query', 'N/record', 'N/render', 'N/runtime', 'N/ui/serverWidget', 'N/url'];

define(Modules, main);

function main(fileModule, httpsModule, logModule,
	queryModule, recordModule, renderModule, runtimeModule, serverWidgetModule, urlModule) {
	file = fileModule;
	https = httpsModule;
	log = logModule;
	query = queryModule;
	record = recordModule;
	render = renderModule;
	runtime = runtimeModule;
	serverWidget = serverWidgetModule;
	url = urlModule;
	return { onRequest }
}

function onRequest(context) {
	const scriptId = runtime.getCurrentScript().id;
	const scriptDeployId = runtime.getCurrentScript().deploymentId;
	scriptURL = url.resolveScript({ scriptId: scriptId, deploymentId: scriptDeployId, returnExternalURL: false });
	if (context.request.method == 'POST') handlePostRequest(context);
	else handleGetRequest(context);
}

function handleGetRequest(context) {
	if (context.request.parameters.hasOwnProperty('function')) {
		if (context.request.parameters['function'] == 'tablesReference') generateTablesReferencePageHtml(context);
		if (context.request.parameters['function'] == 'documentGenerate') generateDocumentFromQueryResults(context);
	} else {
		var form = serverWidget.createForm({ title: `SuiteQL Data Manipulation Tool`, hideNavBar: true });
		var htmlField = form.addField({ id: 'custpage_field_html', type: 'inlineHTML', label: 'HTML' });
		htmlField.defaultValue = generateMainToolInterfaceHtml();
		context.response.writePage(form);
	}
}

function handlePostRequest(context) {
	context.response.setHeader('Content-Type', 'application/json');
	var requestPayload;
	try {
		requestPayload = JSON.parse(context.request.body);
	} catch (e) {
		log.error("Error in Handle Post Request:", e);
		context.response.write(e);
		return;
	}

	switch (requestPayload['function']) {
		case 'documentSubmit': return storeDocumentInfoInSessionForGeneration(context, requestPayload);
		case 'queryExecute': return executeQuery(context, requestPayload);
		case 'sqlFileExists': return checkIfSqlFileExistsInLocalLibrary(context, requestPayload);
		case 'sqlFileLoad': return loadSqlFileFromLocalLibrary(context, requestPayload);
		case 'sqlFileSave': return saveSqlFileToLocalLibrary(context, requestPayload);
		case 'localLibraryFilesGet': return getLocalQueryLibraryFiles(context);
		case 'workbookLoad': return loadQueryFromWorkbook(context, requestPayload);
		case 'workbooksGet': return getListOfAvailableWorkbooks(context);
		default: log.error({ title: 'Payload - Unsupported Function', details: requestPayload['function'] });
	}
}

function generateDocumentFromQueryResults(context) {
	try {
		var sessionScope = runtime.getCurrentSession();
		var docInfo = JSON.parse(sessionScope.get({ name: 'suiteQLDocumentInfo' }));
		var moreRecords = true;
		var pagatedRowBegin = docInfo.rowBegin;
		var paginatedRowEnd = docInfo.rowEnd;
		var queryParams = new Array();
		var records = new Array();
		do {
			var paginatedSQL = 'SELECT * FROM ( SELECT ROWNUM AS ROWNUMBER, * FROM (' + docInfo.query + ' ) ) WHERE ( ROWNUMBER BETWEEN ' + paginatedRowBegin + ' AND ' + paginatedRowEnd + ')';
			var queryResults = query.runSuiteQL({ query: paginatedSQL, params: queryParams }).asMappedResults();
			records = records.concat(queryResults);
			if (queryResults.length < 5000) { moreRecords = false; }
			paginatedRowBegin = paginatedRowBegin + 5000;
		} while (moreRecords);
		var recordsDataSource = { 'records': records };
		var renderer = render.create();
		renderer.addCustomDataSource({ alias: 'results', format: render.DataSource.OBJECT, data: recordsDataSource });
		renderer.templateContent = docInfo.template;
		if (docInfo.docType == 'pdf') {
			let renderObj = renderer.renderAsPdf();
			let pdfString = renderObj.getContents();
			context.response.setHeader('Content-Type', 'application/pdf');
			context.response.write(pdfString);
		} else {
			let htmlString = renderer.renderAsString();
			context.response.setHeader('Content-Type', 'text/html');
			context.response.write(htmlString);
		}
	} catch (e) {
		log.error({ title: 'generateDocumentFromQueryResults Error', details: e });
		context.response.write('Error: ' + e);
	}
}

function storeDocumentInfoInSessionForGeneration(context, requestPayload) {
	try {
		var responsePayload;
		var sessionScope = runtime.getCurrentSession();
		sessionScope.set({ name: 'suiteQLDocumentInfo', value: JSON.stringify(requestPayload) });
		responsePayload = { 'submitted': true }
	} catch (e) {
		log.error({ title: 'StoreDocumentInfoInSessionForGeneration Error:', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}


function executeDelete(sql) {
	const deleteRegex = /^DELETE\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+id\s*=\s*(\d+)/i;
	const match = sql.match(deleteRegex);

	if (!match) {
		throw new Error('Unsupported DELETE format. Use: DELETE FROM [recordtype] WHERE id = [id]');
	}

	const [, recordType, recordId] = match;
	const id = record.delete({
		type: recordType,
		id: Number(recordId),
	});
	return { success: true, message: `Record deleted successfully. Type: ${recordType}, ID: ${id}` };
}

function executeUpdate(sql) {
	const updateRegex = /^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+)\s+WHERE\s+id\s*=\s*(\d+)/i;
	const match = sql.match(updateRegex);

	if (!match) {
		throw new Error('Unsupported UPDATE format. Use: UPDATE [recordtype] SET [field] = \'[value]\' WHERE id = [id]');
	}

	const [, recordType, setClause, recordId] = match;
	const values = {};
	
	// Basic parser for SET clause: key = 'value', key2 = 'value2'
	// This is limited and expects strings to be in single quotes.
	const pairRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:'([^']*)'|(\d+(?:\.\d+)?))/g;
	let pairMatch;
	while ((pairMatch = pairRegex.exec(setClause)) !== null) {
		const key = pairMatch[1];
		const stringValue = pairMatch[2];
		const numberValue = pairMatch[3];
		
		values[key] = (stringValue !== undefined) ? stringValue : Number(numberValue);
	}

	if (Object.keys(values).length === 0) {
		throw new Error('Could not parse SET clause. Ensure values are in single quotes (e.g., field = \'value\') or are numbers.');
	}

	const id = record.submitFields({
		type: recordType,
		id: Number(recordId),
		values: values,
		options: {
			enableSourcing: false,
			ignoreMandatoryFields: true
		}
	});
	return { success: true, message: `Record updated successfully. Type: ${recordType}, ID: ${id}` };
}

function executeInsert(sql) {
	const insertRegex = /^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s+\(([^)]+)\)\s+VALUES\s+\(([^)]+)\)/i;
	const match = sql.match(insertRegex);

	if (!match) {
		throw new Error('Unsupported INSERT format. Use: INSERT INTO [recordtype] (field1, field2) VALUES (\'value1\', \'value2\')');
	}

	const [, recordType, fieldsClause, valuesClause] = match;
	
	const fields = fieldsClause.split(',').map(f => f.trim());
	

	const values = valuesClause.split(',').map(v => {
		let val = v.trim();
		if (val.startsWith("'") && val.endsWith("'")) {
			return val.substring(1, val.length - 1);
		}
		if (!isNaN(val)) {
			return Number(val);
		}
		return val;
	});

	if (fields.length !== values.length) {
		throw new Error('Field count does not match value count.');
	}

	let newRecord = record.create({
		type: recordType,
		isDynamic: true
	});

	for (let i = 0; i < fields.length; i++) {
		newRecord.setValue({
			fieldId: fields[i],
			value: values[i]
		});
	}
	
	const newId = newRecord.save({
		enableSourcing: false,
		ignoreMandatoryFields: true
	});

	return { success: true, message: `Record created successfully. Type: ${recordType}, New ID: ${newId}` };
}


function executeCreate(sql) {
	const createRegex = /^CREATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+)/i;
	const match = sql.match(createRegex);

	if (!match) {
		throw new Error('Unsupported CREATE format. Use: CREATE [recordtype] SET [field] = \'[value]\'');
	}

	const [, recordType, setClause] = match;
	const values = {};
	
	const pairRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:'([^']*)'|(\d+(?:\.\d+)?))/g;
	let pairMatch;
	while ((pairMatch = pairRegex.exec(setClause)) !== null) {
		const key = pairMatch[1];
		const stringValue = pairMatch[2];
		const numberValue = pairMatch[3];
		
		values[key] = (stringValue !== undefined) ? stringValue : Number(numberValue);
	}

	if (Object.keys(values).length === 0) {
		throw new Error('Could not parse SET clause. Ensure values are in single quotes (e.g., field = \'value\') or are numbers.');
	}

	let newRecord = record.create({
		type: recordType,
		isDynamic: true
	});

	for (const fieldId in values) {
		if (Object.hasOwnProperty.call(values, fieldId)) {
			newRecord.setValue({
				fieldId: fieldId,
				value: values[fieldId]
			});
		}
	}
	
	const newId = newRecord.save({
		enableSourcing: false,
		ignoreMandatoryFields: true
	});

	return { success: true, message: `Record created successfully. Type: ${recordType}, New ID: ${newId}` };
}


function parseAndExecuteDml(sql) {
	const trimmedSql = sql.trim();
	let beginTime = new Date().getTime();
	let result;

	try {
		if (/^DELETE/i.test(trimmedSql)) {
			result = executeDelete(trimmedSql);
		} else if (/^UPDATE/i.test(trimmedSql)) {
			result = executeUpdate(trimmedSql);
		} else if (/^INSERT/i.test(trimmedSql)) {
			result = executeInsert(trimmedSql);
		} else if (/^CREATE/i.test(trimmedSql)) {
			result = executeCreate(trimmedSql);
		} else if (/^DROP/i.test(trimmedSql) || /^TRUNCATE/i.test(trimmedSql)) {
			throw new Error('Unsupported DML operation. `DROP` and `TRUNCATE` are blocked for safety. To delete a single record, use: DELETE FROM [recordtype] WHERE id = [id]');
		} else {
			throw new Error('Unsupported DML operation. Only simple CREATE, INSERT, UPDATE, and DELETE are supported.');
		}
		
		let elapsedTime = (new Date().getTime() - beginTime);
		return { 
			dml: true, 
			success: true, 
			message: result.message,
			elapsedTime: elapsedTime
		};

	} catch (e) {
		let elapsedTime = (new Date().getTime() - beginTime);
		log.error({ title: 'DML Parser Error', details: e });
		return { dml: true, success: false, error: { message: e.message }, elapsedTime: elapsedTime };
	}
}


function executeQuery(context, requestPayload) {
	try {
		var responsePayload;
		var queryParams = new Array();
		var nestedSQL = requestPayload.query + "\n";
		
		// DML Execution Path
		if (requestPayload.isDml) {
			responsePayload = parseAndExecuteDml(nestedSQL);
		
		} else {
			var moreRecords = true;
			var records = new Array();
			var totalRecordCount = 0;
			var paginatedRowBegin = requestPayload.rowBegin;
			var paginatedRowEnd = requestPayload.rowEnd;

			if ((requestPayload.viewsEnabled) && (queryFolderID !== null)) {
				var pattern = /(?:^|\s)\#(\w+)\b/ig;
				var views = nestedSQL.match(pattern);
				if ((views !== null) && (views.length > 0)) {
					for (let i = 0; i < views.length; i++) {
						view = views[i].replace(/\s+/g, '');
						viewFileName = view.substring(1, view.length) + '.sql';
						var sql = 'SELECT ID FROM File WHERE ( Folder = ? ) AND ( Name = ? )';
						var queryResults = query.runSuiteQL({ query: sql, params: [queryFolderID, viewFileName] });
						var files = queryResults.asMappedResults();
						if (files.length == 1) {
							var fileObj = file.load({ id: files[0].id });
							nestedSQL = nestedSQL.replace(view, '( ' + fileObj.getContents() + ' ) AS ' + view.substring(1, view.length));
						} else {
							throw { 'name:': 'UnresolvedViewException', 'message': 'Unresolved View ' + viewFileName }
						}
					}
				}
			}
			let beginTime = new Date().getTime();
			if (requestPayload.paginationEnabled) {
				do {
					var paginatedSQL = 'SELECT * FROM ( SELECT ROWNUM AS ROWNUMBER, * FROM ( ' + nestedSQL + ' ) ) WHERE ( ROWNUMBER BETWEEN ' + paginatedRowBegin + ' AND ' + paginatedRowEnd + ')';
					var queryResults = query.runSuiteQL({ query: paginatedSQL, params: queryParams }).asMappedResults();
					records = records.concat(queryResults);
					if (queryResults.length < 5000) { moreRecords = false; }
					paginatedRowBegin = paginatedRowBegin + 5000;
				} while (moreRecords);
			} else {
				records = query.runSuiteQL({ query: nestedSQL, params: queryParams }).asMappedResults();
			}
			let elapsedTime = (new Date().getTime() - beginTime);
			responsePayload = { 'records': records, 'elapsedTime': elapsedTime }
			if (requestPayload.returnTotals) {
				if (records.length > 0) {
					var paginatedSQL = 'SELECT COUNT(*) AS TotalRecordCount FROM ( ' + nestedSQL + ' )';
					var queryResults = query.runSuiteQL({ query: paginatedSQL, params: queryParams }).asMappedResults();
					responsePayload.totalRecordCount = queryResults[0].totalrecordcount;
				}
			}
		}
	} catch (e) {
		log.error({ title: 'executeQuery Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}


function getLocalQueryLibraryFiles(context) {
	var responsePayload;
	var sql = ` SELECT ID, Name, Description FROM File WHERE ( Folder = ? ) ORDER BY Name `;
	var queryResults = query.runSuiteQL({ query: sql, params: [queryFolderID] });
	var records = queryResults.asMappedResults();
	if (records.length > 0) {
		responsePayload = { 'records': records };
	} else {
		responsePayload = { 'error': 'No SQL Files' };
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function checkIfSqlFileExistsInLocalLibrary(context, requestPayload) {
	var responsePayload;
	var sql = ` SELECT ID FROM File WHERE ( Folder = ? ) AND ( Name = ? ) `;
	var queryResults = query.runSuiteQL({ query: sql, params: [queryFolderID, requestPayload.filename] });
	var records = queryResults.asMappedResults();
	if (records.length > 0) {
		responsePayload = { 'exists': true };
	} else {
		responsePayload = { 'exists': false };
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function loadSqlFileFromLocalLibrary(context, requestPayload) {
	var responsePayload;
	try {
		var fileObj = file.load({ id: requestPayload.fileID });
		responsePayload = {}
		responsePayload.file = fileObj;
		responsePayload.sql = fileObj.getContents();
	} catch (e) {
		log.error({ title: 'loadSqlFileFromLocalLibrary Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function saveSqlFileToLocalLibrary(context, requestPayload) {
	var responsePayload;
	try {
		var fileObj = file.create({
			name: requestPayload.filename,
			contents: requestPayload.contents,
			description: requestPayload.description,
			fileType: file.Type.PLAINTEXT,
			folder: queryFolderID,
			isOnline: false
		});
		var fileID = fileObj.save();
		responsePayload = {}
		responsePayload.fileID = fileID;
	} catch (e) {
		log.error({ title: 'saveSqlFileToLocalLibrary Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function loadQueryFromWorkbook(context, requestPayload) {
	var responsePayload;
	try {
		var loadedQuery = query.load({ id: requestPayload.scriptID });
		responsePayload = {}
		responsePayload.sql = loadedQuery.toSuiteQL().query;
	} catch (e) {
		log.error({ title: 'loadQueryFromWorkbook Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function getListOfAvailableWorkbooks(context) {
	var responsePayload;
	var sql = `
        SELECT
            ScriptID,
            Name,
            Description,
            BUILTIN.DF( Owner ) AS Owner
        FROM
            UsrSavedSearch
        ORDER BY
            Name
    `;
	var queryResults = query.runSuiteQL({ query: sql, params: [] });
	var records = queryResults.asMappedResults();
	if (records.length > 0) {
		responsePayload = { 'records': records };
	} else {
		responsePayload = { 'error': 'No Workbooks' };
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function generateMainToolInterfaceHtml() {
	return `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>SuiteQL Data Manipulation Tool</title>
			<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
			<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
			<script src="/ui/jquery/jquery-3.5.1.min.js"></script>
			<link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
			<script src="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/js/bootstrap.min.js"></script>
			<link rel="stylesheet" type="text/css" href="https://cdn.datatables.net/1.10.25/css/jquery.dataTables.css">
			<script type="text/javascript" charset="utf8" src="https://cdn.datatables.net/1.10.25/js/jquery.dataTables.js"></script>
			
			<!-- CodeMirror resources -->
			<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/codemirror.min.css">
			<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/addon/hint/show-hint.min.css">
			<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/theme/material.min.css">
			<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/codemirror.min.js"></script>
			<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/mode/sql/sql.min.js"></script>
			<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/addon/hint/show-hint.min.js"></script>
			<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/addon/hint/sql-hint.min.js"></script>

			<style>
				:root {
					--primary-color: #3498db; --background-color: #f4f6f8; --editor-bg: #ffffff;
					--text-color: #2c3e50; --border-color: #dfe4ea; --header-height: 50px;
					--drawer-width: 280px; --fab-size: 56px; --danger-color: #e74c3c;
				}
				body { font-family: 'Inter', sans-serif; background-color: var(--background-color); color: var(--text-color); margin: 0; padding: 0; overflow: hidden; }
				.app-container { display: flex; flex-direction: column; height: 100vh; }
				.app-header { height: var(--header-height); background-color: var(--editor-bg); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; flex-shrink: 0; }
				.header-icon { cursor: pointer; color: #576574; padding: 8px; border-radius: 50%; transition: background-color 0.2s ease; }
				.header-icon:hover { background-color: #f1f2f6; }
				.app-main { flex-grow: 1; display: flex; flex-direction: column; position: relative; overflow: hidden; }
				.query-editor-area { flex: 1; display: flex; flex-direction: column; /* REMOVED padding */ position: relative; min-height: 100px; }
				#query { display: none; } /* Hide original textarea */
				.CodeMirror {
					flex-grow: 1;
					border: 1px solid var(--border-color);
					width: 90vw;
					max-width: 100%;
					border-radius: 8px;
					font-size: 14px;
					height: auto;
					margin: 16px auto 0; /* CHANGED margin: top 16, sides auto, bottom 0 */
					box-sizing: border-box;
					transition: border-color 0.2s ease, box-shadow 0.2s ease;
				}
				.CodeMirror-focused {
					outline: none !important;
					border-color: var(--primary-color) !important;
					box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2) !important;
				}
				.CodeMirror-hints {
					z-index: 1001;
					position: absolute;
				}
				#fileInfo { font-size: 12px; color: #8395a7; padding: 4px 8px; position: absolute; bottom: 8px; left: 24px; background: rgba(255,255,255,0.8); border-radius: 4px; }
				#resultsDiv {
					flex-shrink: 0;
					height: 50vh;
					min-height: 100px;
					width: 90vw; 
					max-width: 100%; 
					background-color: var(--editor-bg);
					padding: 16px;
					border: 1px solid var(--border-color);
					border-radius: 8px;
					margin: 16px auto; /* CHANGED to explicit margin-top */
					overflow-y: auto;
					display: flex;
					flex-direction: column;
					box-sizing: border-box; 
				}
				.results-header { margin-bottom: 12px; flex-shrink: 0; }
				.results-title { font-weight: 600; font-size: 16px; color: #2c3e50; }
				.results-meta { font-size: 12px; color: #8395a7; }
				.nav-drawer { position: fixed; top: 0; left: 0; width: var(--drawer-width); height: 100%; background-color: var(--editor-bg); border-right: 1px solid var(--border-color); transform: translateX(-100%); transition: transform 0.3s ease-in-out; z-index: 1100; display: flex; flex-direction: column; }
				.nav-drawer.open { transform: translateX(0); box-shadow: 0 0 25px rgba(0,0,0,0.1); }
				.drawer-header { padding: 0 16px; height: var(--header-height); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; }
				.drawer-title { font-weight: 600; }
				.drawer-menu { list-style: none; padding: 8px 0; margin: 0; }
				.drawer-menu li a { display: flex; align-items: center; padding: 12px 24px; color: #576574; text-decoration: none; font-weight: 500; font-size: 14px; transition: background-color 0.2s ease, color 0.2s ease; }
				.drawer-menu li a .material-icons { margin-right: 16px; font-size: 20px; }
				.drawer-menu li a:hover { background-color: #f1f2f6; color: var(--primary-color); }
				.backdrop { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.4); z-index: 1099; display: none; }
				.backdrop.visible { display: block; }
				.settings-popover { position: absolute; top: calc(var(--header-height) - 5px); right: 16px; width: 320px; background-color: var(--editor-bg); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); z-index: 1050; padding: 16px; display: none; }
				.popover-section { margin-bottom: 16px; }
				.popover-section:last-child { margin-bottom: 0; }
				.popover-title { font-size: 13px; font-weight: 600; color: var(--text-color); margin-bottom: 8px; }
				.fab { position: fixed; bottom: 24px; right: 24px; width: var(--fab-size); height: var(--fab-size); background-color: var(--primary-color); color: white; border: none; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background-color 0.2s ease, transform 0.2s ease, all 0.3s; z-index: 1000; }
				.fab:hover { background-color: #2980b9; transform: translateY(-2px); }
				.fab .material-icons { font-size: 28px; }
				.fab-danger { background-color: var(--danger-color); }
				.fab-danger:hover { background-color: #c0392b; }
				.modal-header .close { outline: none; }
				.modal-content { border-radius: 8px; }
				.btn { border-radius: 6px; }
				#recentQueriesList .code-snippet { font-family: monospace; background-color: #f1f2f6; padding: 4px 8px; border-radius: 4px; word-break: break-all; display: block; max-height: 60px; overflow-y: auto; }
				.dataTables_scrollBody { border: 1px solid #ddd; border-radius: 4px; }
				.dataTables_scrollBody::-webkit-scrollbar { height: 10px; }
				.dataTables_scrollBody::-webkit-scrollbar-track { background: #f1f1f1; }
				.dataTables_scrollBody::-webkit-scrollbar-thumb { background: #ccc; border-radius: 4px; }
				.dataTables_scrollBody::-webkit-scrollbar-thumb:hover { background: #aaa; }
			</style>
		</head>
		<body>
			<div class="app-container">
				<header class="app-header">
					<span class="material-icons header-icon" id="menu-toggle">menu</span>
					<span class="material-icons header-icon" id="settings-toggle">settings</span>
				</header>
				<main class="app-main">
					<div class="query-editor-area">
						<textarea id="query"></textarea>
						<div id="fileInfo"></div>
					</div>
					<div id="resultsDiv" style="display: none;"></div>
				</main>
			</div>
			<button type="button" class="fab" id="run-query-fab" title="Run Query (Ctrl+Enter)"><span class="material-icons">play_arrow</span></button>
			<nav class="nav-drawer" id="nav-drawer">
				<div class="drawer-header"><span class="drawer-title">Actions & Libraries</span></div>
				<ul class="drawer-menu">
					<li><a href="#" id="tables-ref-link"><span class="material-icons">table_chart</span>Tables Reference</a></li>
					<li><a href="#" data-toggle="modal" data-target="#recentQueriesModal"><span class="material-icons">history</span>Recent Queries</a></li>
					<li><a href="#" data-toggle="modal" data-target="#localLoadModal"><span class="material-icons">folder_open</span>Local Library</a></li>
					<li><a href="#" data-toggle="modal" data-target="#remoteLoadModal"><span class="material-icons">cloud_queue</span>Remote Library</a></li>
					<li><a href="#" data-toggle="modal" data-target="#saveModal"><span class="material-icons">save</span>Save Query</a></li>
				</ul>
			</nav>
			<div class="backdrop" id="backdrop"></div>
			<div class="settings-popover" id="settings-popover">
				<div class="popover-section"><div class="form-check"><input class="form-check-input" type="checkbox" id="enablePagination" onChange="togglePaginationOptionsVisibility();"><label class="form-check-label" for="enablePagination" style="font-size: 14px;">Enable Pagination</label></div></div>
				<div id="pagination-options" style="display: none;">
					<div class="popover-section">
						<div class="form-group mb-2"><label for="rowBegin" style="font-size:13px; font-weight: 500;">Return Rows</label><div class="input-group"><input type="number" class="form-control form-control-sm" id="rowBegin" value="1"><div class="input-group-prepend input-group-append"><span class="input-group-text">to</span></div><input type="number" class="form-control form-control-sm" id="rowEnd" value="${rowsReturnedDefault}"></div></div>
						<div class="form-check"><input class="form-check-input" type="checkbox" id="returnAll" onChange="toggleReturnAllRowsOption();"><label class="form-check-label" for="returnAll" style="font-size: 14px;">Return All Rows</label></div>
						<div class="form-check"><input class="form-check-input" type="checkbox" id="returnTotals"><label class="form-check-label" for="returnTotals" style="font-size: 14px;">Count Total Rows</label></div>
					</div>
				</div>
				<div class="popover-section"><div class="popover-title">Result Format</div><div class="btn-group btn-group-toggle d-flex" data-toggle="buttons"><label class="btn btn-outline-secondary btn-sm flex-fill active"><input type="radio" name="resultsFormat" value="table" checked onChange="generateResponseOutputBasedOnFormat();"> Table</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="resultsFormat" value="csv" onChange="generateResponseOutputBasedOnFormat();"> CSV</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="resultsFormat" value="json" onChange="generateResponseOutputBasedOnFormat();"> JSON</label></div></div>
				<div class="popover-section"><div class="popover-title">NULL Display</div><div class="btn-group btn-group-toggle d-flex" data-toggle="buttons"><label class="btn btn-outline-secondary btn-sm flex-fill active"><input type="radio" name="nullFormat" value="dimmed" checked onChange="generateResponseOutputBasedOnFormat();"> Dim</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="nullFormat" value="blank" onChange="generateResponseOutputBasedOnFormat();"> Blank</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="nullFormat" value="null" onChange="generateResponseOutputBasedOnFormat();"> Text</label></div></div>
			</div>
			${generateDmlWarningModalHtml()}
			${generateLocalLibraryLoadModalHtml()}
			${generateRemoteLibraryLoadModalHtml()}
			${generateRecentQueriesModalHtml()}
			${generateSaveQueryModalHtml()}
			${generateWorkbooksModalHtml()}
			<script>
				var editor, activeSQLFile = {}, queryResponsePayload, fileLoadResponsePayload;
				window.jQuery = window.$ = jQuery;

				$('form').on('submit', function(e) { e.preventDefault(); return false; });

				$(document).ready(function() {
					const menuToggle = $('#menu-toggle');
					const settingsToggle = $('#settings-toggle');
					const navDrawer = $('#nav-drawer');
					const settingsPopover = $('#settings-popover');
					const backdrop = $('#backdrop');
					const fab = $('#run-query-fab');

					editor = CodeMirror.fromTextArea(document.getElementById('query'), {
						lineNumbers: true,
						mode: 'text/x-sql',
						theme: 'material',
						lineWrapping: true,
						extraKeys: { "Ctrl-Space": "autocomplete" },
						hintOptions: { completeSingle: false }
					});

					editor.on('inputRead', function(cm, event) {
						if (event.origin !== '+input') return;
						if (event.text[0] && (/[a-zA-Z]/).test(event.text[0])) {
							setTimeout(function() { cm.execCommand("autocomplete"); }, 100);
						}
					});

					editor.on('change', function() { 
						refreshUnsavedFileStatusIndicator(); 
						checkQueryForDml();
					});

					function closeAll() {
						navDrawer.removeClass('open');
						settingsPopover.fadeOut(100);
						backdrop.removeClass('visible');
					}

					menuToggle.on('click', function(e) {
						e.stopPropagation();
						settingsPopover.hide();
						navDrawer.toggleClass('open');
						backdrop.toggleClass('visible', navDrawer.hasClass('open'));
					});

					settingsToggle.on('click', function(e) {
						e.stopPropagation();
						navDrawer.removeClass('open');
						settingsPopover.fadeToggle(100);
						backdrop.removeClass('visible');
					});

					$('.drawer-menu a').on('click', function() { setTimeout(closeAll, 200); });
					backdrop.on('click', closeAll);
					$(document).on('click', function(e) {
						if (!$(e.target).closest('#nav-drawer, #settings-popover, #menu-toggle, #settings-toggle').length) {
							closeAll();
						}
					});

					fab.on('click', submitQueryForExecution);
					$('#tables-ref-link').on('click', function(e) { e.preventDefault(); openTablesReferenceWindow(); });
					$('#dmlWarningAccept').on('click', acceptDmlWarning);
					$('#dmlWarningCheckbox').on('change', function() {
						$('#dmlWarningAccept').prop('disabled', !$(this).is(':checked'));
					});

					$('input[type="number"], input[type="text"]').on('keydown', function(e) { if (e.keyCode === 13) { e.preventDefault(); return false; } });
					
					$(document).keydown(function(e) {
						if ((e.ctrlKey || e.metaKey) && e.keyCode == 13) { submitQueryForExecution(); }
						if (e.keyCode === 27) { closeAll(); }
					});

					setDefaultQueryInEditor();
					refreshUnsavedFileStatusIndicator();
					checkQueryForDml();
				});

				function checkQueryForDml() {
					const fab = $('#run-query-fab');
					const fabIcon = fab.find('.material-icons');
					const queryText = editor.getValue();
					const isDml = /^(CREATE|UPDATE|INSERT|DELETE|DROP|TRUNCATE)/im.test(queryText.trim());

					if (isDml) {
						fab.addClass('fab-danger');
						fabIcon.text('warning');
						fab.attr('title', 'Run DML Query (Ctrl+Enter)');
					} else {
						fab.removeClass('fab-danger');
						fabIcon.text('play_arrow');
						fab.attr('title', 'Run Query (Ctrl+Enter)');
					}
				}

				function acceptDmlWarning() {
					if ($('#dmlWarningCheckbox').is(':checked')) {
						localStorage.setItem('suiteql_dml_warning_accepted', 'true');
						$('#dmlWarningModal').modal('hide');
						submitQueryForExecution(); // Proceed with submission
					}
				}

				${generateJsForSettingDefaultQuery()}
				${generateJsForTogglingPaginationOptions()}
				${generateJsForRefreshingFileInfoDisplay()}
				${generateJsForGettingLocalLibraryFiles()}
				${generateJsForLoadingLocalSqlFile()}
				${generateJsForSavingLocalSqlFile()}
				${generateJsForSubmittingQuery()}
				${generateJsForResizingQueryTextArea()}
				${generateJsForGettingRadioFieldValue()}
				${generateJsForFetchingRemoteLibraryIndex()}
				${generateJsForLoadingRemoteSqlFile()}
				${generateJsForCopyingResponseData()}
				${generateJsForGeneratingResponseOutput()}
				${generateJsForGeneratingCsvResponse()}
				${generateJsForGeneratingJsonResponse()}
				${generateJsForGeneratingHtmlTableResponse()}
				${generateJsForTogglingReturnAllRowsOption()}
				${generateJsForOpeningTablesReference()}
				${generateJsForLoadingWorkbook()}
				${generateJsForGettingWorkbooksList()}
				${generateJsForGettingRecentQueries()}
				${generateJsForLoadingRecentQuery()}
				${generateJsForSavingRecentQuery()}
				${generateJQueryEventHandlersForModals()}
				${generateJsForGettingTableDetails()}
				${generateJsForGettingTableNames()}
				${generateJsForCopyingTableQuery()}
			</script>
		</body>
		</html>
    `;
}

function generateTablesReferencePageHtml(context) {
	var form = serverWidget.createForm({ title: 'SuiteQL Tables Reference', hideNavBar: false });
	var htmlField = form.addField({ id: 'custpage_field_html', type: serverWidget.FieldType.INLINEHTML, label: 'HTML' });
	htmlField.defaultValue = `
        <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
        <script src="/ui/jquery/jquery-3.5.1.min.js"></script>
        <script src="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/js/bootstrap.min.js"></script>
        <link rel="stylesheet" type="text/css" href="https://cdn.datatables.net/1.10.25/css/jquery.dataTables.css">
        <script type="text/javascript" charset="utf8" src="https://cdn.datatables.net/1.10.25/js/jquery.dataTables.js"></script>
        <style> body { font-family: 'Inter', sans-serif; background-color: #f4f6f8; padding: 20px; } p, pre, td, th { font-size: 14px; } th { font-weight: 600; } .card { border: none; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); } .card-header { font-weight: 600; background-color: #fff; } </style>
        <div class="container-fluid"><div class="row"><div class="col-md-4"><div class="card"><div class="card-header">Tables</div><div class="card-body" id="tablesColumn">Loading...</div></div></div><div class="col-md-8"><div class="card"><div class="card-header">Details</div><div class="card-body" id="tableInfoColumn">Select a table to view its details.</div></div></div></div></div>
        <script> window.jQuery = window.$ = jQuery; ${generateJsForGettingTableDetails()} ${generateJsForGettingTableNames()} ${generateJsForCopyingTableQuery()} fetchAndDisplayAllTableNames(); </script>
    `;
	context.response.writePage(form);
}

function generateDmlWarningModalHtml() {
	return `<div class="modal fade" id="dmlWarningModal" tabindex="-1" role="dialog" data-backdrop="static" data-keyboard="false">
		<div class="modal-dialog modal-dialog-centered" role="document">
			<div class="modal-content" style="border: 3px solid var(--danger-color);">
				<div class="modal-header" style="background-color: var(--danger-color); color: white;">
					<h4 class="modal-title"><span class="material-icons" style="vertical-align: middle; margin-right: 8px;">warning</span>DML Operation Warning</h4>
					<button type="button" class="close" data-dismiss="modal" aria-label="Close" style="color: white; opacity: 0.8;">
						<span aria-hidden="true">&times;</span>
					</button>
				</div>
				<div class="modal-body">
					<p>You are about to execute a data manipulation (DML) query (<code>INSERT</code>, <code>UPDATE</code>, <code>DELETE</code>).</p>
					<p><strong>This action is irreversible and can lead to permanent data loss or corruption.</strong></p>
					<ul style="padding-left: 20px;">
						<li>This feature will attempt to parse your SQL and run it <strong>immediately</strong> using the <strong>N/record module</strong>.</li>
						<li>It is <strong>NOT</strong> a full SQL parser. Only simple queries are supported.</li>
						<li>It is <strong>STRONGLY</strong> recommended to only use this in a <strong>Sandbox account</strong>.</li>
						<li>Always back up your data before proceeding.</li>
						<li>Verify your query syntax carefully.</li>
					</ul>
					<hr>
					<div class="form-check">
						<input class="form-check-input" type="checkbox" id="dmlWarningCheckbox">
						<label class="form-check-label" for="dmlWarningCheckbox" style="font-weight: 500;">
							I understand the risks and want to proceed.
						</label>
					</div>
				</div>
				<div class="modal-footer">
					<button type="button" class="btn btn-secondary" data-dismiss="modal">Cancel</button>
					<button type="button" class="btn btn-danger" id="dmlWarningAccept" disabled>Accept and Execute</button>
				</div>
			</div>
		</div>
	</div>`;
}
function generateLocalLibraryLoadModalHtml() { return `<div class="modal fade" id="localLoadModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Local Query Library</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="localSQLFilesList"></div></div></div></div>`; }
function generateRemoteLibraryLoadModalHtml() { return `<div class="modal fade" id="remoteLoadModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Remote Query Library</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="remoteSQLFilesList"></div></div></div></div>`; }
function generateRecentQueriesModalHtml() { return `<div class="modal fade" id="recentQueriesModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Recent Queries</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="recentQueriesList"></div></div></div></div>`; }
function generateSaveQueryModalHtml() { return `<div class="modal fade" id="saveModal"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Save Query</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body"><div id="saveQueryMessage" style="display: none;"></div><div id="saveQueryForm" style="display: none;"><div class="form-group"><label for="saveQueryFormFileName">File Name</label><input type="text" class="form-control" id="saveQueryFormFileName"></div><div class="form-group"><label for="saveQueryFormDescription">Description</label><input type="text" class="form-control" id="saveQueryFormDescription"></div><button type="button" class="btn btn-primary" onclick="saveSqlFileToLocalLibraryWithPrompt();">Save</button></div></div></div></div>`; }
function generateWorkbooksModalHtml() { return workbooksEnabled ? `<div class="modal fade" id="workbooksModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Workbooks</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="workbooksList"></div></div></div></div>` : ``; }
function generateJQueryEventHandlersForModals() { return `$('#localLoadModal').on('shown.bs.modal', function (e) { fetchAndDisplayLocalLibraryFiles(); }); $('#remoteLoadModal').on('shown.bs.modal', function (e) { fetchAndDisplayRemoteLibraryIndex(); }); $('#recentQueriesModal').on('shown.bs.modal', function (e) { displayRecentQueriesFromLocalStorage(); }); $('#saveModal').on('shown.bs.modal', function (e) { $('#saveQueryMessage, #saveQueryForm').hide(); if (editor.getValue() == '') { $('#saveQueryMessage').html('<p class="text-danger">Please enter a query.</p>').show(); } else { $('#saveQueryForm').show(); $('#saveQueryFormFileName').val(activeSQLFile.fileName || '').focus(); $('#saveQueryFormDescription').val(activeSQLFile.description || ''); } }); $('#workbooksModal').on('shown.bs.modal', function (e) { fetchAndDisplayWorkbooksList(); });`; }
function generateJsForSettingDefaultQuery() { return `function setDefaultQueryInEditor() { editor.setValue('SELECT\\n\\tID,\\n\\tLastName,\\n\\tFirstName,\\n\\tPhone,\\n\\tEmail\\nFROM\\n\\tEmployee'); }`; }
function generateJsForTogglingPaginationOptions() { return `function togglePaginationOptionsVisibility() { const isChecked = $('#enablePagination').is(':checked'); $('#pagination-options').toggle(isChecked); }`; }
function generateJsForRefreshingFileInfoDisplay() { return `function refreshUnsavedFileStatusIndicator() { var content = ''; if (activeSQLFile.source == undefined) { if (editor.getValue() != '') { content = '<span class="text-danger">Unsaved</span>'; } } else { var status = (editor.getValue() != activeSQLFile.sql) ? 'Changed' : 'Unchanged'; var tooltip = 'Source: ' + activeSQLFile.source + '\\nStatus: ' + status; content = '<span title="' + tooltip + '">' + activeSQLFile.fileName + '</span>'; if (status === 'Changed') { content = '<span class="text-danger">' + content + '</span>'; } } $('#fileInfo').html(content); }`; }
function generateJsForSubmittingQuery() { 
	return `function submitQueryForExecution() { 
		var queryText = editor.getValue(); 
		if (!queryText) { 
			alert('Please enter a query.'); 
			return; 
		} 
		
		var selectedText = editor.getSelection(); 
		var theQuery = selectedText || queryText; 
		const isDml = /^(CREATE|UPDATE|INSERT|DELETE|DROP|TRUNCATE)/im.test(theQuery.trim());

		// Check for DML warning
		if (isDml && localStorage.getItem('suiteql_dml_warning_accepted') !== 'true') {
			$('#dmlWarningModal').modal('show');
			return; // Stop execution until user accepts
		}

		var rowBegin = 1, rowEnd = 999999; 
		if ($('#enablePagination').is(':checked') && !$('#returnAll').is(':checked')) { 
			rowBegin = parseInt($('#rowBegin').val()) || 1; 
			rowEnd = parseInt($('#rowEnd').val()) || ${rowsReturnedDefault}; 
		} 
		
		$('#resultsDiv').show(); 
		$('#resultsDiv').html('<h5>Running query...</h5>'); 
		
		var requestPayload = { 
			'function': 'queryExecute', 
			'query': theQuery, 
			'isDml': isDml,
			'rowBegin': rowBegin, 
			'rowEnd': rowEnd, 
			'paginationEnabled': $('#enablePagination').is(':checked'), 
			'viewsEnabled': false, 
			'returnTotals': $('#returnTotals').is(':checked') 
		}; 
		
		$.post({ 
			url: '${scriptURL}', 
			data: JSON.stringify(requestPayload), 
			contentType: 'application/json' 
		}).done(function(response) { 
			queryResponsePayload = response; 
			
			// Handle DML response
			if (queryResponsePayload.dml) {
				if (queryResponsePayload.success) {
					$('#resultsDiv').html('<h5 class="text-success">Success</h5><p>' + queryResponsePayload.message + '</p>');
				} else {
					$('#resultsDiv').html('<h5 class="text-danger">DML Error</h5><pre>' + (queryResponsePayload.error.message || queryResponsePayload.error) + '</pre>');
				}
			
			// Handle standard error
			} else if (queryResponsePayload.error) { 
				$('#resultsDiv').html('<h5 class="text-danger">Error</h5><pre>' + queryResponsePayload.error.message + '</pre>'); 
			
			// Handle SELECT response
			} else { 
				saveQueryToRecentQueries(theQuery); 
				generateResponseOutputBasedOnFormat(); 
			} 
		}).fail(function(xhr) { 
			$('#resultsDiv').html('<h5 class="text-danger">Error</h5><pre>XHR Error: ' + xhr.status + ' ' + xhr.statusText + '</pre>'); 
		}); 
	}`; 
}
function generateJsForResizingQueryTextArea() { return `function resizeQueryTextArea() { /* Auto-resize handled by flexbox and CodeMirror */ }`; }
function generateJsForGettingRadioFieldValue() { return `function getCheckedRadioValue(name) { return $('input[name="' + name + '"]:checked').val(); }`; }
function generateJsForFetchingRemoteLibraryIndex() { return `function fetchAndDisplayRemoteLibraryIndex() { $('#remoteSQLFilesList').html('<h5>Loading...</h5>'); $.getJSON('https://suiteql.s3.us-east-1.amazonaws.com/queries/index.json?nonce=' + new Date().getTime()).done(function(payload) { let content = '<table id="remoteFilesTable" class="table table-sm table-hover" style="width:100%"><thead><tr><th>Name</th><th>Description</th><th></th></tr></thead><tbody>'; payload.forEach(r => { content += '<tr><td>' + r.name + '</td><td>' + r.description + '</td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="loadSqlFileFromRemoteLibrary(\\\`' + r.fileName + '\\\`)">Load</button></td></tr>'; }); content += '</tbody></table>'; $('#remoteSQLFilesList').html(content); if (datatablesEnabled) { $('#remoteFilesTable').DataTable({"pageLength": 10}); } }).fail(function(xhr) { $('#remoteSQLFilesList').html('<p class="text-danger">' + xhr.status + '</p>'); }); }`; }
function generateJsForLoadingRemoteSqlFile() { return `function loadSqlFileFromRemoteLibrary(filename) { $.get('https://suiteql.s3.us-east-1.amazonaws.com/queries/' + filename + '?nonce=' + new Date().getTime()).done(function(response) { editor.setValue(response); activeSQLFile = { source: 'Remote', fileName: filename, sql: response }; refreshUnsavedFileStatusIndicator(); $('#remoteLoadModal').modal('hide'); $('#resultsDiv').hide(); }).fail(function(xhr) { alert('Error: ' + xhr.status); }); }`; }
function generateJsForCopyingResponseData() { return `function copyResponseDataToClipboard() { $('#responseData').select(); document.execCommand('copy'); }`; }
function generateJsForGeneratingResponseOutput() { return `function generateResponseOutputBasedOnFormat() { if (!queryResponsePayload || queryResponsePayload.dml) return; switch (getCheckedRadioValue('resultsFormat')) { case 'csv': generateCsvFromResponseData(); break; case 'json': generateJsonFromResponseData(); break; default: generateHtmlTableFromResponseData(); } }`; }
function generateJsForGeneratingCsvResponse() { return `function generateCsvFromResponseData() { if (!queryResponsePayload || !queryResponsePayload.records || queryResponsePayload.records.length === 0) { $('#resultsDiv').html('<h5 class="text-warning">No records to display.</h5>'); return; } const columnNames = Object.keys(queryResponsePayload.records[0]); let csv = '"' + columnNames.join('","') + '"\\r\\n'; queryResponsePayload.records.forEach(record => { let values = columnNames.map(col => { let val = record[col] === null ? '' : String(record[col]); return '"' + val.replace(/"/g, '""') + '"'; }); csv += values.join(',') + '\\r\\n'; }); let header = '<div class="results-header"><div class="results-title">CSV Results</div><div class="results-meta">' + queryResponsePayload.records.length + ' rows in ' + queryResponsePayload.elapsedTime + 'ms</div></div>'; $('#resultsDiv').html(header + '<textarea id="responseData" class="form-control" rows="10">' + csv + '</textarea>'); }`; }
function generateJsForGeneratingJsonResponse() { return `function generateJsonFromResponseData() { let header = '<div class="results-header"><div class="results-title">JSON Results</div><div class="results-meta">' + queryResponsePayload.records.length + ' rows in ' + queryResponsePayload.elapsedTime + 'ms</div></div>'; let jsonString = JSON.stringify(queryResponsePayload.records, null, 2); $('#resultsDiv').html(header + '<textarea id="responseData" class="form-control" rows="10">' + jsonString + '</textarea>'); }`; }
function generateJsForGeneratingHtmlTableResponse() { return `function generateHtmlTableFromResponseData() { if (!queryResponsePayload || !queryResponsePayload.records || queryResponsePayload.records.length === 0) { $('#resultsDiv').html('<h5 class="text-warning">No records found.</h5>'); return; } const records = queryResponsePayload.records; const columnNames = Object.keys(records[0]); let header = '<div class="results-header"><div class="results-title">Results</div><div class="results-meta">' + records.length + ' rows returned in ' + queryResponsePayload.elapsedTime + 'ms.</div></div>'; let table = '<div class="table-responsive" style="overflow-y: auto; flex-grow: 1;"><table id="resultsTable" class="table table-sm table-hover" style="width:100%"><thead><tr>'; columnNames.forEach(col => { table += '<th>' + col + '</th>'; }); table += '</tr></thead><tbody>'; const nullFormat = getCheckedRadioValue('nullFormat'); records.forEach(rec => { table += '<tr>'; columnNames.forEach(col => { let val = rec[col]; if (val === null) { if (nullFormat === 'blank') val = ''; else if (nullFormat === 'dimmed') val = '<span style="color: #ccc;">null</span>'; else val = 'null'; } table += '<td>' + val + '</td>'; }); table += '</tr>'; }); table += '</tbody></table></div>'; $('#resultsDiv').html(header + table); if (datatablesEnabled) { $('#resultsTable').DataTable({"pageLength": 10, "scrollX": true}); } }`; }
function generateJsForTogglingReturnAllRowsOption() { return `function toggleReturnAllRowsOption() { $('#rowBegin, #rowEnd').prop('disabled', $('#returnAll').is(':checked')); }`; }
function generateJsForOpeningTablesReference() { return `function openTablesReferenceWindow() { window.open('${scriptURL}&function=tablesReference', '_tablesRef'); }`; }
function generateJsForGettingRecentQueries() { return `function displayRecentQueriesFromLocalStorage() { let recentQueries = JSON.parse(localStorage.getItem('suiteql_recentQueries') || '[]'); let content = ''; if (recentQueries.length === 0) { content = '<p>No recent queries found.</p>'; } else { content = '<table class="table table-sm table-hover"><thead><tr><th>Query</th><th></th></tr></thead><tbody>'; recentQueries.forEach((query, index) => { let displayQuery = query.replace(/\\n|\\t/g, ' ').trim(); content += '<tr><td><code class="code-snippet">' + displayQuery + '</code></td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="loadQueryFromRecentQueries(' + index + ')">Load</button></td></tr>'; }); content += '</tbody></table>'; } $('#recentQueriesList').html(content); }`; }
function generateJsForLoadingRecentQuery() { return `function loadQueryFromRecentQueries(index) { let recentQueries = JSON.parse(localStorage.getItem('suiteql_recentQueries') || '[]'); if (recentQueries[index]) { editor.setValue(recentQueries[index]); $('#recentQueriesModal').modal('hide'); $('#resultsDiv').hide(); activeSQLFile = {}; refreshUnsavedFileStatusIndicator(); } }`; }
function generateJsForSavingRecentQuery() { return `function saveQueryToRecentQueries(queryToSave) { const MAX_RECENT_QUERIES = 20; let recentQueries = JSON.parse(localStorage.getItem('suiteql_recentQueries') || '[]'); const existingIndex = recentQueries.indexOf(queryToSave); if (existingIndex > -1) { recentQueries.splice(existingIndex, 1); } recentQueries.unshift(queryToSave); if (recentQueries.length > MAX_RECENT_QUERIES) { recentQueries = recentQueries.slice(0, MAX_RECENT_QUERIES); } localStorage.setItem('suiteql_recentQueries', JSON.stringify(recentQueries)); }`; }
function generateJsForGettingTableDetails() { return `function fetchAndDisplayTableDetails(tableName) { $('#tableInfoColumn').html('<h5>Loading ' + tableName + '...</h5>'); var url = '/app/recordscatalog/rcendpoint.nl?action=getRecordTypeDetail&data=' + encodeURI(JSON.stringify({ scriptId: tableName, detailType: 'SS_ANAL' })); $.getJSON(url).done(function(response) { let recordDetail = response.data; let content = '<h4 class="mb-3">' + recordDetail.label + ' ("' + tableName + '")</h4>'; content += '<h5>Columns</h5><table class="table table-sm" id="tableColumnsTable"><thead><tr><th>Label</th><th>Name</th><th>Type</th></tr></thead><tbody>'; recordDetail.fields.forEach(f => { if (f.isColumn) { content += '<tr><td>' + f.label + '</td><td>' + f.id + '</td><td>' + f.dataType + '</td></tr>'; } }); content += '</tbody></table>'; $('#tableInfoColumn').html(content); if (datatablesEnabled) { $('#tableColumnsTable').DataTable({"pageLength": 10}); } }); }`; }
function generateJsForGettingTableNames() { return `function fetchAndDisplayAllTableNames() { var url = '/app/recordscatalog/rcendpoint.nl?action=getRecordTypes&data=' + encodeURI(JSON.stringify({ structureType: 'FLAT' })); $.getJSON(url).done(function(response) { let recordTypes = response.data; let content = '<table class="table table-sm table-hover" id="tableNamesTable"><thead><tr><th>Table Name</th></tr></thead><tbody>'; recordTypes.forEach(rt => { content += '<tr><td><a href="#" onclick="fetchAndDisplayTableDetails(\\\`' + rt.id + '\\\`)">' + rt.label + '</a><br><small class="text-muted">' + rt.id + '</small></td></tr>'; }); content += '</tbody></table>'; $('#tablesColumn').html(content); if (datatablesEnabled) { $('#tableNamesTable').DataTable({"pageLength": 10}); } }); }`; }
function generateJsForCopyingTableQuery() {
	const copyTableQuery = `
		function copyTableQueryToClipboard() {
			$('#tableQuery').select(); document.execCommand('copy');
		}`
	return copyTableQuery;
}

function generateJsForGettingLocalLibraryFiles() {
	return `function fetchAndDisplayLocalLibraryFiles() {
		$('#localSQLFilesList').html('<h5>Loading...</h5>');
		$.post({
			url: '${scriptURL}',
			data: JSON.stringify({ 'function': 'localLibraryFilesGet' }),
			contentType: 'application/json'
		}).done(function(payload) {
			if (payload.error) {
				$('#localSQLFilesList').html('<p class="text-danger">' + payload.error + '</p>');
				return;
			}
			let content = '<table id="localFilesTable" class="table table-sm table-hover" style="width:100%"><thead><tr><th>Name</th><th>Description</th><th></th></tr></thead><tbody>';
			payload.records.forEach(r => {
				content += '<tr><td>' + (r.name || '') + '</td><td>' + (r.description || '') + '</td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="loadSqlFileFromLocalLibraryById(' + r.id + ')">Load</button></td></tr>';
			});
			content += '</tbody></table>';
			$('#localSQLFilesList').html(content);
			if (datatablesEnabled) { $('#localFilesTable').DataTable({"pageLength": 10}); }
		}).fail(function(xhr) {
			$('#localSQLFilesList').html('<p class="text-danger">Error: ' + xhr.status + '</p>');
		});
	}`;
}

function generateJsForLoadingLocalSqlFile() {
	return `function loadSqlFileFromLocalLibraryById(fileID) {
		$.post({
			url: '${scriptURL}',
			data: JSON.stringify({ 'function': 'sqlFileLoad', 'fileID': fileID }),
			contentType: 'application/json'
		}).done(function(payload) {
			if (payload.error) { alert('Error: ' + payload.error); return; }
			editor.setValue(payload.sql);
			activeSQLFile = { source: 'Local', fileName: payload.file.name, description: payload.file.description, fileID: payload.file.id, sql: payload.sql };
			refreshUnsavedFileStatusIndicator();
			$('#localLoadModal').modal('hide');
			$('#resultsDiv').hide();
		}).fail(function(xhr) {
			alert('Error: ' + xhr.status);
		});
	}`;
}

function generateJsForSavingLocalSqlFile() {
	return `function saveSqlFileToLocalLibraryWithPrompt() {
		var filename = $('#saveQueryFormFileName').val();
		if (!filename) { alert('Please enter a file name.'); return; }
		$.post({
			url: '${scriptURL}',
			data: JSON.stringify({ 'function': 'sqlFileExists', 'filename': filename }),
			contentType: 'application/json'
		}).done(function(fileExistsPayload) {
			if (fileExistsPayload.exists && !confirm("A file named '" + filename + "' already exists. Overwrite?")) {
				return;
			}
			var savePayload = {
				'function': 'sqlFileSave',
				'filename': filename,
				'contents': editor.getValue(),
				'description': $('#saveQueryFormDescription').val()
			};
			$.post({
				url: '${scriptURL}',
				data: JSON.stringify(savePayload),
				contentType: 'application/json'
			}).done(function(fileSavePayload) {
				if (fileSavePayload.error) { alert('Error: ' + fileSavePayload.error); return; }
				activeSQLFile = { source: 'Local', fileName: filename, description: savePayload.description, fileID: fileSavePayload.fileID, sql: savePayload.contents };
				refreshUnsavedFileStatusIndicator();
				alert('File saved.');
				$('#saveModal').modal('hide');
			}).fail(function(xhr) {
				alert('Save Error: ' + xhr.status);
			});
		}).fail(function(xhr) {
			alert('File Check Error: ' + xhr.status);
		});
	}`;
}

function generateJsForLoadingWorkbook() {
	return `function loadQueryFromWorkbookById(scriptID) {
		$.post({
			url: '${scriptURL}',
			data: JSON.stringify({ 'function': 'workbookLoad', 'scriptID': scriptID }),
			contentType: 'application/json'
		}).done(function(payload) {
			if (payload.error) { alert('Error: '.concat(payload.error)); return; }
			editor.setValue(payload.sql);
			$('#workbooksModal').modal('hide');
			$('#resultsDiv').hide();
			activeSQLFile = { source: 'Workbook ' + scriptID, fileName: '', description: '', fileID: '', sql: payload.sql };
			refreshUnsavedFileStatusIndicator();
		}).fail(function(xhr) {
			alert('Error: ' + xhr.status);
		});
	}`;
}

function generateJsForGettingWorkbooksList() {
	return `function fetchAndDisplayWorkbooksList() {
		$('#workbooksList').html('<h5>Loading...</h5>');
		$.post({
			url: '${scriptURL}',
			data: JSON.stringify({ 'function': 'workbooksGet' }),
			contentType: 'application/json'
		}).done(function(payload) {
			if (payload.error) {
				$('#workbooksList').html('<p class="text-danger">' + payload.error + '</p>');
				return;
			}
			let content = '<table id="workbooksTable" class="table table-sm table-hover" style="width:100%"><thead><tr><th>Name</th><th>Description</th><th>Owner</th><th></th></tr></thead><tbody>';
			payload.records.forEach(r => {
				content += '<tr><td>' + (r.name || '') + '</td><td>' + (r.description || '') + '</td><td>' + (r.owner || '') + '</td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="loadQueryFromWorkbookById(\\\`' + r.scriptid + '\\\`)">Load</button></td></tr>';
			});
			content += '</tbody></table>';
			$('#workbooksList').html(content);
			if (datatablesEnabled) { $('#workbooksTable').DataTable({"pageLength": 10}); }
		}).fail(function(xhr) {
			$('#workbooksList').html('<p class="text-danger">Error loading workbooks: ' + xhr.statusText + '</p>');
		});
	}`;
}
