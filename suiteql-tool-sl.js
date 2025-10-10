/**
* @NApiVersion 2.1
* @NScriptType Suitelet
* @NModuleScope Public
*/

define(['N/file', 'N/https', 'N/log', 'N/query', 'N/record', 'N/render', 'N/runtime', 'N/ui/serverWidget', 'N/url'], main);

var file, https, log, query, record, render, runtime, scriptURL, url, version = '2025.1-Moss-Beta';
var datatablesEnabled = true,
	remoteLibraryEnabled = true,
	rowsReturnedDefault = 50,
	queryFolderID = null,
	workbooksEnabled = false;


function main(fileModule, httpsModule, logModule, queryModule, recordModule, renderModule, runtimeModule, serverWidgetModule, urlModule) {
	file = fileModule;
	https = httpsModule;
	log = logModule;
	query = queryModule;
	record = recordModule;
	render = renderModule;
	runtime = runtimeModule;
	serverWidget = serverWidgetModule;
	url = urlModule;

	return {
		onRequest: function (context) {
			scriptURL = url.resolveScript({ scriptId: runtime.getCurrentScript().id, deploymentId: runtime.getCurrentScript().deploymentId, returnExternalURL: false });

			if (context.request.method == 'POST') {
				postRequestHandle(context);
			} else {
				getRequestHandle(context);
			}
		}
	}
}

function getRequestHandle(context) {
	if (context.request.parameters.hasOwnProperty('function')) {
		if (context.request.parameters['function'] == 'tablesReference') { htmlGenerateTablesReference(context); }
		if (context.request.parameters['function'] == 'documentGenerate') { documentGenerate(context); }
	} else {
		var form = serverWidget.createForm({ title: `SuiteQL Query Tool`, hideNavBar: true });
		var htmlField = form.addField({ id: 'custpage_field_html', type: serverWidget.FieldType.INLINEHTML, label: 'HTML' });
		htmlField.defaultValue = htmlGenerateTool();
		context.response.writePage(form);
	}
}

function postRequestHandle(context) {
	context.response.setHeader('Content-Type', 'application/json');
	var requestPayload;
	try {
		requestPayload = JSON.parse(context.request.body);
	} catch (e) {
		log.error({
			title: 'FATAL: Failed to parse request body',
			details: 'Body received: ' + context.request.body
		});
		context.response.write(JSON.stringify({ 'error': { message: 'Invalid request from client. Could not parse JSON body. See execution log for details.' } }));
		return;
	}

	switch (requestPayload['function']) {
		case 'documentSubmit': return documentSubmit(context, requestPayload);
		case 'queryExecute': return queryExecute(context, requestPayload);
		case 'sqlFileExists': return sqlFileExists(context, requestPayload);
		case 'sqlFileLoad': return sqlFileLoad(context, requestPayload);
		case 'sqlFileSave': return sqlFileSave(context, requestPayload);
		case 'localLibraryFilesGet': return localLibraryFilesGet(context);
		case 'workbookLoad': return workbookLoad(context, requestPayload);
		case 'workbooksGet': return workbooksGet(context);
		default: log.error({ title: 'Payload - Unsupported Function', details: requestPayload['function'] });
	}
}


function documentGenerate(context) {
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
		log.error({ title: 'documentGenerate Error', details: e });
		context.response.write('Error: ' + e);
	}
}


function documentSubmit(context, requestPayload) {
	try {
		var responsePayload;
		var sessionScope = runtime.getCurrentSession();
		sessionScope.set({ name: 'suiteQLDocumentInfo', value: JSON.stringify(requestPayload) });
		responsePayload = { 'submitted': true }
	} catch (e) {
		log.error({ title: 'documentSubmit Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}


function queryExecute(context, requestPayload) {
	try {
		var responsePayload;
		var moreRecords = true;
		var records = new Array();
		var totalRecordCount = 0;
		var queryParams = new Array();
		var paginatedRowBegin = requestPayload.rowBegin;
		var paginatedRowEnd = requestPayload.rowEnd;
		var nestedSQL = requestPayload.query + "\n";
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
	} catch (e) {
		log.error({ title: 'queryExecute Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}


function localLibraryFilesGet(context) {
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


function sqlFileExists(context, requestPayload) {
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


function sqlFileLoad(context, requestPayload) {
	var responsePayload;
	try {
		var fileObj = file.load({ id: requestPayload.fileID });
		responsePayload = {}
		responsePayload.file = fileObj;
		responsePayload.sql = fileObj.getContents();
	} catch (e) {
		log.error({ title: 'sqlFileLoad Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}


function sqlFileSave(context, requestPayload) {
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
		log.error({ title: 'sqlFileSave Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function workbookLoad(context, requestPayload) {
	var responsePayload;
	try {
		var loadedQuery = query.load({ id: requestPayload.scriptID });
		responsePayload = {}
		responsePayload.sql = loadedQuery.toSuiteQL().query;
	} catch (e) {
		log.error({ title: 'workbookLoad Error', details: e });
		responsePayload = { 'error': e }
	}
	context.response.write(JSON.stringify(responsePayload, null, 5));
}

function workbooksGet(context) {
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

function htmlGenerateTool() {
	return `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>SuiteQL Query Tool</title>
			<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
			<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
			<script src="/ui/jquery/jquery-3.5.1.min.js"></script>
			<link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
			<script src="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/js/bootstrap.min.js"></script>
			<link rel="stylesheet" type="text/css" href="https://cdn.datatables.net/1.10.25/css/jquery.dataTables.css">
 			<script type="text/javascript" charset="utf8" src="https://cdn.datatables.net/1.10.25/js/jquery.dataTables.js"></script>
			<style>
				:root {
					--primary-color: #3498db; --background-color: #f4f6f8; --editor-bg: #ffffff;
					--text-color: #2c3e50; --border-color: #dfe4ea; --header-height: 50px;
					--drawer-width: 280px; --fab-size: 56px;
				}
				body { font-family: 'Inter', sans-serif; background-color: var(--background-color); color: var(--text-color); margin: 0; padding: 0; overflow: hidden; }
				.app-container { display: flex; flex-direction: column; height: 100vh; }
				.app-header { height: var(--header-height); background-color: var(--editor-bg); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; flex-shrink: 0; }
				.header-icon { cursor: pointer; color: #576574; padding: 8px; border-radius: 50%; transition: background-color 0.2s ease; }
				.header-icon:hover { background-color: #f1f2f6; }
				.app-title { font-weight: 600; font-size: 16px; color: var(--text-color); }
				.app-main { flex-grow: 1; display: flex; flex-direction: column; position: relative; overflow: hidden; }
				.query-editor-area { flex: 1; display: flex; flex-direction: column; padding: 16px 16px 0 16px; position: relative; min-height: 100px; }
#query {
  flex-grow: 1;
  border: 1px solid var(--border-color);
  width: 90vw;          
  max-width: 100%;       
  border-radius: 8px;
  padding: 16px;
  font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  background-color: var(--editor-bg);
  color: #2d3436;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  white-space: pre;
  overflow-wrap: normal;
  overflow: auto;
  box-sizing: border-box; 
  margin: 16px auto;      
}
				#query:focus { outline: none; border-color: var(--primary-color); box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2); }
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
  margin: 16px auto; 
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
				.fab { position: fixed; bottom: 24px; right: 24px; width: var(--fab-size); height: var(--fab-size); background-color: var(--primary-color); color: white; border: none; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background-color 0.2s ease, transform 0.2s ease; z-index: 1000; }
				.fab:hover { background-color: #2980b9; transform: translateY(-2px); }
				.fab .material-icons { font-size: 28px; }
				.modal-header .close { outline: none; }
				.modal-content { border-radius: 8px; }
				.btn { border-radius: 6px; }
				#recentQueriesList .code-snippet { font-family: monospace; background-color: #f1f2f6; padding: 4px 8px; border-radius: 4px; word-break: break-all; display: block; max-height: 60px; overflow-y: auto; }

				/* --- Styles for Horizontal Scrolling --- */

				/* For the results table, the DataTables library creates a scrollable container.
				   The class for this container is .dataTables_scrollBody. We are styling it here. */
				.dataTables_scrollBody {
					border: 1px solid #ddd;
					border-radius: 4px;
				}

                /* Optional: Nicer looking scrollbar for Chrome/Safari */
				.dataTables_scrollBody::-webkit-scrollbar {
					height: 10px;
				}
				.dataTables_scrollBody::-webkit-scrollbar-track {
					background: #f1f1f1;
				}
				.dataTables_scrollBody::-webkit-scrollbar-thumb {
					background: #ccc;
					border-radius: 4px;
				}
				.dataTables_scrollBody::-webkit-scrollbar-thumb:hover {
					background: #aaa;
				}
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
						<textarea id="query" placeholder="Enter SuiteQL query here..."></textarea>
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
				<div class="popover-section"><div class="form-check"><input class="form-check-input" type="checkbox" id="enablePagination" onChange="enablePaginationToggle();"><label class="form-check-label" for="enablePagination" style="font-size: 14px;">Enable Pagination</label></div></div>
				<div id="pagination-options" style="display: none;">
					<div class="popover-section">
						<div class="form-group mb-2"><label for="rowBegin" style="font-size:13px; font-weight: 500;">Return Rows</label><div class="input-group"><input type="number" class="form-control form-control-sm" id="rowBegin" value="1"><div class="input-group-prepend input-group-append"><span class="input-group-text">to</span></div><input type="number" class="form-control form-control-sm" id="rowEnd" value="${rowsReturnedDefault}"></div></div>
						<div class="form-check"><input class="form-check-input" type="checkbox" id="returnAll" onChange="returnAllToggle();"><label class="form-check-label" for="returnAll" style="font-size: 14px;">Return All Rows</label></div>
						<div class="form-check"><input class="form-check-input" type="checkbox" id="returnTotals"><label class="form-check-label" for="returnTotals" style="font-size: 14px;">Count Total Rows</label></div>
					</div>
				</div>
				<div class="popover-section"><div class="popover-title">Result Format</div><div class="btn-group btn-group-toggle d-flex" data-toggle="buttons"><label class="btn btn-outline-secondary btn-sm flex-fill active"><input type="radio" name="resultsFormat" value="table" checked onChange="responseGenerate();"> Table</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="resultsFormat" value="csv" onChange="responseGenerate();"> CSV</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="resultsFormat" value="json" onChange="responseGenerate();"> JSON</label></div></div>
				<div class="popover-section"><div class="popover-title">NULL Display</div><div class="btn-group btn-group-toggle d-flex" data-toggle="buttons"><label class="btn btn-outline-secondary btn-sm flex-fill active"><input type="radio" name="nullFormat" value="dimmed" checked onChange="responseGenerate();"> Dim</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="nullFormat" value="blank" onChange="responseGenerate();"> Blank</label><label class="btn btn-outline-secondary btn-sm flex-fill"><input type="radio" name="nullFormat" value="null" onChange="responseGenerate();"> Text</label></div></div>
			</div>
			${htmlLocalLoadModal()}
			${htmlRemoteLoadModal()}
			${htmlRecentQueriesModal()}
			${htmlSaveModal()}
			${htmlWorkbooksModal()}
			<script>
				var activeSQLFile = {}, queryResponsePayload, fileLoadResponsePayload;
				window.jQuery = window.$ = jQuery;

				// MASTER FIX: Prevent the NetSuite form wrapper from ever submitting.
				$('form').on('submit', function(e) {
					e.preventDefault();
					return false;
				});

				$(document).ready(function() {
					const menuToggle = $('#menu-toggle');
					const settingsToggle = $('#settings-toggle');
					const navDrawer = $('#nav-drawer');
					const settingsPopover = $('#settings-popover');
					const backdrop = $('#backdrop');
					const fab = $('#run-query-fab');

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

					$('.drawer-menu a').on('click', function() {
						setTimeout(closeAll, 200);
					});

					backdrop.on('click', closeAll);
					$(document).on('click', function(e) {
						if (!$(e.target).closest('#nav-drawer, #settings-popover, #menu-toggle, #settings-toggle').length) {
							closeAll();
						}
					});

					fab.on('click', querySubmit);
					$('#tables-ref-link').on('click', function(e) { e.preventDefault(); tablesReferenceOpen(); });

					$('input[type="number"], input[type="text"]').on('keydown', function(e) {
						if (e.keyCode === 13) {
							e.preventDefault();
							return false;
						}
					});

					$(document).keydown(function(e) {
						if ((e.ctrlKey || e.metaKey) && e.keyCode == 13) { querySubmit(); }
						if (e.keyCode === 27) { closeAll(); }
					});
					
				});
				${jsFunctionDefaultQuerySet()}
				${jsFunctionEnablePaginationToggle()}
				${jsFunctionFileInfoRefresh()}
				${jsFunctionLocalLibraryFilesGet()}
				${jsFunctionLocalSQLFileLoad()}
				${jsFunctionLocalSQLFileSave()}
				${jsFunctionQuerySubmit()}
				${jsFunctionQueryTextAreaResize()}
				${jsFunctionRadioFieldValueGet()}
				${jsFunctionRemoteLibraryIndexGet()}
				${jsFunctionRemoteSQLFileLoad()}
				${jsFunctionResponseDataCopy()}
				${jsFunctionResponseGenerate()}
				${jsFunctionResponseGenerateCSV()}
				${jsFunctionResponseGenerateJSON()}
				${jsFunctionResponseGenerateTable()}
				${jsFunctionReturnAllToggle()}
				${jsFunctiontablesReferenceOpen()}
				${jsFunctionWorkbookLoad()}
				${jsFunctionWorkbooksListGet()}
				${jsFunctionRecentQueriesGet()}
				${jsFunctionRecentQueryLoad()}
				${jsFunctionRecentQuerySave()}
				${jqueryModalHandlers()}
				${jsFunctionTableDetailsGet()}
				${jsFunctionTableNamesGet()}
				${jsFunctionTableQueryCopy()}
			</script>
		</body>
		</html>
	`;
}

function htmlGenerateTablesReference(context) {
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
		<script> window.jQuery = window.$ = jQuery; ${jsFunctionTableDetailsGet()} ${jsFunctionTableNamesGet()} ${jsFunctionTableQueryCopy()} tableNamesGet(); </script>
	`;
	context.response.writePage(form);
}

function htmlLocalLoadModal() { return `<div class="modal fade" id="localLoadModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Local Query Library</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="localSQLFilesList"></div></div></div></div>`; }
function htmlRemoteLoadModal() { return `<div class="modal fade" id="remoteLoadModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Remote Query Library</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="remoteSQLFilesList"></div></div></div></div>`; }
function htmlRecentQueriesModal() { return `<div class="modal fade" id="recentQueriesModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Recent Queries</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="recentQueriesList"></div></div></div></div>`; }
function htmlSaveModal() { return `<div class="modal fade" id="saveModal"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Save Query</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body"><div id="saveQueryMessage" style="display: none;"></div><div id="saveQueryForm" style="display: none;"><div class="form-group"><label for="saveQueryFormFileName">File Name</label><input type="text" class="form-control" id="saveQueryFormFileName"></div><div class="form-group"><label for="saveQueryFormDescription">Description</label><input type="text" class="form-control" id="saveQueryFormDescription"></div><button type="button" class="btn btn-primary" onclick="localSQLFileSave();">Save</button></div></div></div></div>`; }
function htmlWorkbooksModal() { return workbooksEnabled ? `<div class="modal fade" id="workbooksModal"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">Workbooks</h4><button type="button" class="close" data-dismiss="modal">&times;</button></div><div class="modal-body" id="workbooksList"></div></div></div></div>` : ``; }

function jqueryModalHandlers() { return `$('#localLoadModal').on('shown.bs.modal', function (e) { localLibraryFilesGet(); }); $('#remoteLoadModal').on('shown.bs.modal', function (e) { remoteLibraryIndexGet(); }); $('#recentQueriesModal').on('shown.bs.modal', function (e) { recentQueriesGet(); }); $('#saveModal').on('shown.bs.modal', function (e) { $('#saveQueryMessage, #saveQueryForm').hide(); if ($('#query').val() == '') { $('#saveQueryMessage').html('<p class="text-danger">Please enter a query.</p>').show(); } else { $('#saveQueryForm').show(); $('#saveQueryFormFileName').val(activeSQLFile.fileName || '').focus(); $('#saveQueryFormDescription').val(activeSQLFile.description || ''); } }); $('#workbooksModal').on('shown.bs.modal', function (e) { workbooksListGet(); });`; }
function jsFunctionDefaultQuerySet() { return `function defaultQuerySet() { $('#query').val('SELECT\\n\\tID,\\n\\tLastName,\\n\\tFirstName,\\n\\tPhone,\\n\\tEmail\\nFROM\\n\\tEmployee\\nLIMIT 10'); }`; }
function jsFunctionEnablePaginationToggle() { return `function enablePaginationToggle() { const isChecked = $('#enablePagination').is(':checked'); $('#pagination-options').toggle(isChecked); }`; }
function jsFunctionFileInfoRefresh() { return `function fileInfoRefresh() { var content = ''; if (activeSQLFile.source == undefined) { if ($('#query').val() != '') { content = '<span class="text-danger">Unsaved</span>'; } } else { var status = ($('#query').val() != activeSQLFile.sql) ? 'Changed' : 'Unchanged'; var tooltip = 'Source: ' + activeSQLFile.source + '\\nStatus: ' + status; content = '<span title="' + tooltip + '">' + activeSQLFile.fileName + '</span>'; if (status === 'Changed') { content = '<span class="text-danger">' + content + '</span>'; } } $('#fileInfo').html(content); }`; }
function jsFunctionQuerySubmit() { return `function querySubmit() { var queryText = $('#query').val(); if (!queryText) { alert('Please enter a query.'); return; } var selectedText = ''; var textArea = document.getElementById('query'); if (textArea.selectionStart !== undefined && textArea.selectionStart != textArea.selectionEnd) { selectedText = textArea.value.substring(textArea.selectionStart, textArea.selectionEnd); } var theQuery = selectedText || queryText; var rowBegin = 1, rowEnd = 999999; if ($('#enablePagination').is(':checked') && !$('#returnAll').is(':checked')) { rowBegin = parseInt($('#rowBegin').val()) || 1; rowEnd = parseInt($('#rowEnd').val()) || ${rowsReturnedDefault}; } $('#resultsDiv').show(); $('#resultsDiv').html('<h5>Running query...</h5>'); var requestPayload = { 'function': 'queryExecute', 'query': theQuery, 'rowBegin': rowBegin, 'rowEnd': rowEnd, 'paginationEnabled': $('#enablePagination').is(':checked'), 'viewsEnabled': false, 'returnTotals': $('#returnTotals').is(':checked') }; $.post({ url: '${scriptURL}', data: JSON.stringify(requestPayload), contentType: 'application/json' }).done(function(response) { queryResponsePayload = response; if (queryResponsePayload.error) { $('#resultsDiv').html('<h5 class="text-danger">Error</h5><pre>' + queryResponsePayload.error.message + '</pre>'); } else { recentQuerySave(theQuery); responseGenerate(); } }).fail(function(xhr) { $('#resultsDiv').html('<h5 class="text-danger">Error</h5><pre>XHR Error: ' + xhr.status + ' ' + xhr.statusText + '</pre>'); }); }`; }
function jsFunctionQueryTextAreaResize() { return `function queryTextAreaResize() { /* Auto-resize handled by flexbox */ }`; }
function jsFunctionRadioFieldValueGet() { return `function radioFieldValueGet(name) { return $('input[name="' + name + '"]:checked').val(); }`; }
function jsFunctionRemoteLibraryIndexGet() { return `function remoteLibraryIndexGet() { $('#remoteSQLFilesList').html('<h5>Loading...</h5>'); $.getJSON('https://suiteql.s3.us-east-1.amazonaws.com/queries/index.json?nonce=' + new Date().getTime()).done(function(payload) { let content = '<table id="remoteFilesTable" class="table table-sm table-hover" style="width:100%"><thead><tr><th>Name</th><th>Description</th><th></th></tr></thead><tbody>'; payload.forEach(r => { content += '<tr><td>' + r.name + '</td><td>' + r.description + '</td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="remoteSQLFileLoad(\\\`' + r.fileName + '\\\`)">Load</button></td></tr>'; }); content += '</tbody></table>'; $('#remoteSQLFilesList').html(content); if (datatablesEnabled) { $('#remoteFilesTable').DataTable({"pageLength": 10}); } }).fail(function(xhr) { $('#remoteSQLFilesList').html('<p class="text-danger">' + xhr.status + '</p>'); }); }`; }
function jsFunctionRemoteSQLFileLoad() { return `function remoteSQLFileLoad(filename) { $.get('https://suiteql.s3.us-east-1.amazonaws.com/queries/' + filename + '?nonce=' + new Date().getTime()).done(function(response) { $('#query').val(response); activeSQLFile = { source: 'Remote', fileName: filename, sql: response }; fileInfoRefresh(); $('#remoteLoadModal').modal('hide'); $('#resultsDiv').hide(); }).fail(function(xhr) { alert('Error: ' + xhr.status); }); }`; }
function jsFunctionResponseDataCopy() { return `function responseDataCopy() { $('#responseData').select(); document.execCommand('copy'); }`; }
function jsFunctionResponseGenerate() { return `function responseGenerate() { switch (radioFieldValueGet('resultsFormat')) { case 'csv': responseGenerateCSV(); break; case 'json': responseGenerateJSON(); break; default: responseGenerateTable(); } }`; }
function jsFunctionResponseGenerateCSV() { return `function responseGenerateCSV() { if (!queryResponsePayload || !queryResponsePayload.records || queryResponsePayload.records.length === 0) { $('#resultsDiv').html('<h5 class="text-warning">No records to display.</h5>'); return; } const columnNames = Object.keys(queryResponsePayload.records[0]); let csv = '"' + columnNames.join('","') + '"\\r\\n'; queryResponsePayload.records.forEach(record => { let values = columnNames.map(col => { let val = record[col] === null ? '' : String(record[col]); return '"' + val.replace(/"/g, '""') + '"'; }); csv += values.join(',') + '\\r\\n'; }); let header = '<div class="results-header"><div class="results-title">CSV Results</div><div class="results-meta">' + queryResponsePayload.records.length + ' rows in ' + queryResponsePayload.elapsedTime + 'ms</div></div>'; $('#resultsDiv').html(header + '<textarea id="responseData" class="form-control" rows="10">' + csv + '</textarea>'); }`; }
function jsFunctionResponseGenerateJSON() { return `function responseGenerateJSON() { let header = '<div class="results-header"><div class="results-title">JSON Results</div><div class="results-meta">' + queryResponsePayload.records.length + ' rows in ' + queryResponsePayload.elapsedTime + 'ms</div></div>'; let jsonString = JSON.stringify(queryResponsePayload.records, null, 2); $('#resultsDiv').html(header + '<textarea id="responseData" class="form-control" rows="10">' + jsonString + '</textarea>'); }`; }
function jsFunctionResponseGenerateTable() { return `function responseGenerateTable() { if (!queryResponsePayload || !queryResponsePayload.records || queryResponsePayload.records.length === 0) { $('#resultsDiv').html('<h5 class="text-warning">No records found.</h5>'); return; } const records = queryResponsePayload.records; const columnNames = Object.keys(records[0]); let header = '<div class="results-header"><div class="results-title">Results</div><div class="results-meta">' + records.length + ' rows returned in ' + queryResponsePayload.elapsedTime + 'ms.</div></div>'; let table = '<div class="table-responsive" style="overflow-y: auto; flex-grow: 1;"><table id="resultsTable" class="table table-sm table-hover" style="width:100%"><thead><tr>'; columnNames.forEach(col => { table += '<th>' + col + '</th>'; }); table += '</tr></thead><tbody>'; const nullFormat = radioFieldValueGet('nullFormat'); records.forEach(rec => { table += '<tr>'; columnNames.forEach(col => { let val = rec[col]; if (val === null) { if (nullFormat === 'blank') val = ''; else if (nullFormat === 'dimmed') val = '<span style="color: #ccc;">null</span>'; else val = 'null'; } table += '<td>' + val + '</td>'; }); table += '</tr>'; }); table += '</tbody></table></div>'; $('#resultsDiv').html(header + table); if (datatablesEnabled) { $('#resultsTable').DataTable({"pageLength": 10, "scrollX": true}); } }`; }
function jsFunctionReturnAllToggle() { return `function returnAllToggle() { $('#rowBegin, #rowEnd').prop('disabled', $('#returnAll').is(':checked')); }`; }
function jsFunctiontablesReferenceOpen() { return `function tablesReferenceOpen() { window.open('${scriptURL}&function=tablesReference', '_tablesRef'); }`; }
function jsFunctionRecentQueriesGet() { return `function recentQueriesGet() { let recentQueries = JSON.parse(localStorage.getItem('suiteql_recentQueries') || '[]'); let content = ''; if (recentQueries.length === 0) { content = '<p>No recent queries found.</p>'; } else { content = '<table class="table table-sm table-hover"><thead><tr><th>Query</th><th></th></tr></thead><tbody>'; recentQueries.forEach((query, index) => { let displayQuery = query.replace(/\\n|\\t/g, ' ').trim(); content += '<tr><td><code class="code-snippet">' + displayQuery + '</code></td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="recentQueryLoad(' + index + ')">Load</button></td></tr>'; }); content += '</tbody></table>'; } $('#recentQueriesList').html(content); }`; }
function jsFunctionRecentQueryLoad() { return `function recentQueryLoad(index) { let recentQueries = JSON.parse(localStorage.getItem('suiteql_recentQueries') || '[]'); if (recentQueries[index]) { $('#query').val(recentQueries[index]); $('#recentQueriesModal').modal('hide'); $('#resultsDiv').hide(); activeSQLFile = {}; fileInfoRefresh(); } }`; }
function jsFunctionRecentQuerySave() { return `function recentQuerySave(queryToSave) { const MAX_RECENT_QUERIES = 20; let recentQueries = JSON.parse(localStorage.getItem('suiteql_recentQueries') || '[]'); const existingIndex = recentQueries.indexOf(queryToSave); if (existingIndex > -1) { recentQueries.splice(existingIndex, 1); } recentQueries.unshift(queryToSave); if (recentQueries.length > MAX_RECENT_QUERIES) { recentQueries = recentQueries.slice(0, MAX_RECENT_QUERIES); } localStorage.setItem('suiteql_recentQueries', JSON.stringify(recentQueries)); }`; }
function jsFunctionTableDetailsGet() { return `function tableDetailsGet(tableName) { $('#tableInfoColumn').html('<h5>Loading ' + tableName + '...</h5>'); var url = '/app/recordscatalog/rcendpoint.nl?action=getRecordTypeDetail&data=' + encodeURI(JSON.stringify({ scriptId: tableName, detailType: 'SS_ANAL' })); $.getJSON(url).done(function(response) { let recordDetail = response.data; let content = '<h4 class="mb-3">' + recordDetail.label + ' ("' + tableName + '")</h4>'; content += '<h5>Columns</h5><table class="table table-sm" id="tableColumnsTable"><thead><tr><th>Label</th><th>Name</th><th>Type</th></tr></thead><tbody>'; recordDetail.fields.forEach(f => { if (f.isColumn) { content += '<tr><td>' + f.label + '</td><td>' + f.id + '</td><td>' + f.dataType + '</td></tr>'; } }); content += '</tbody></table>'; $('#tableInfoColumn').html(content); if (datatablesEnabled) { $('#tableColumnsTable').DataTable({"pageLength": 10}); } }); }`; }
function jsFunctionTableNamesGet() { return `function tableNamesGet() { var url = '/app/recordscatalog/rcendpoint.nl?action=getRecordTypes&data=' + encodeURI(JSON.stringify({ structureType: 'FLAT' })); $.getJSON(url).done(function(response) { let recordTypes = response.data; let content = '<table class="table table-sm table-hover" id="tableNamesTable"><thead><tr><th>Table Name</th></tr></thead><tbody>'; recordTypes.forEach(rt => { content += '<tr><td><a href="#" onclick="tableDetailsGet(\\\`' + rt.id + '\\\`)">' + rt.label + '</a><br><small class="text-muted">' + rt.id + '</small></td></tr>'; }); content += '</tbody></table>'; $('#tablesColumn').html(content); if (datatablesEnabled) { $('#tableNamesTable').DataTable({"pageLength": 10}); } }); }`; }
function jsFunctionTableQueryCopy() { return `function tableQueryCopy() { $('#tableQuery').select(); document.execCommand('copy'); }`; }

function jsFunctionLocalLibraryFilesGet() {
	return `function localLibraryFilesGet() {
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
				content += '<tr><td>' + (r.name || '') + '</td><td>' + (r.description || '') + '</td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="localSQLFileLoad(' + r.id + ')">Load</button></td></tr>';
			});
			content += '</tbody></table>';
			$('#localSQLFilesList').html(content);
			if (datatablesEnabled) { $('#localFilesTable').DataTable({"pageLength": 10}); }
		}).fail(function(xhr) {
			$('#localSQLFilesList').html('<p class="text-danger">Error: ' + xhr.status + '</p>');
		});
	}`;
}

function jsFunctionLocalSQLFileLoad() {
	return `function localSQLFileLoad(fileID) {
		$.post({
			url: '${scriptURL}',
			data: JSON.stringify({ 'function': 'sqlFileLoad', 'fileID': fileID }),
			contentType: 'application/json'
		}).done(function(payload) {
			if (payload.error) { alert('Error: ' + payload.error); return; }
			$('#query').val(payload.sql);
			activeSQLFile = { source: 'Local', fileName: payload.file.name, description: payload.file.description, fileID: payload.file.id, sql: payload.sql };
			fileInfoRefresh();
			$('#localLoadModal').modal('hide');
			$('#resultsDiv').hide();
		}).fail(function(xhr) {
			alert('Error: ' + xhr.status);
		});
	}`;
}

function jsFunctionLocalSQLFileSave() {
	return `function localSQLFileSave() {
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
				'contents': $('#query').val(),
				'description': $('#saveQueryFormDescription').val()
			};
			$.post({
				url: '${scriptURL}',
				data: JSON.stringify(savePayload),
				contentType: 'application/json'
			}).done(function(fileSavePayload) {
				if (fileSavePayload.error) { alert('Error: ' + fileSavePayload.error); return; }
				activeSQLFile = { source: 'Local', fileName: filename, description: savePayload.description, fileID: fileSavePayload.fileID, sql: savePayload.contents };
				fileInfoRefresh();
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

function jsFunctionWorkbookLoad() {
	return `function workbookLoad(scriptID) {
		$.post({
			url: '${scriptURL}',
			data: JSON.stringify({ 'function': 'workbookLoad', 'scriptID': scriptID }),
			contentType: 'application/json'
		}).done(function(payload) {
			if (payload.error) { alert('Error: ' + payload.error); return; }
			$('#query').val(payload.sql);
			$('#workbooksModal').modal('hide');
			$('#resultsDiv').hide();
			activeSQLFile = { source: 'Workbook ' + scriptID, fileName: '', description: '', fileID: '', sql: payload.sql };
			fileInfoRefresh();
		}).fail(function(xhr) {
			alert('Error: ' + xhr.status);
		});
	}`;
}

function jsFunctionWorkbooksListGet() {
	return `function workbooksListGet() {
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
				content += '<tr><td>' + (r.name || '') + '</td><td>' + (r.description || '') + '</td><td>' + (r.owner || '') + '</td><td class="text-right"><button class="btn btn-sm btn-primary" onclick="workbookLoad(\\\`' + r.scriptid + '\\\`)">Load</button></td></tr>';
			});
			content += '</tbody></table>';
			$('#workbooksList').html(content);
			if (datatablesEnabled) { $('#workbooksTable').DataTable({"pageLength": 10}); }
		}).fail(function(xhr) {
			$('#workbooksList').html('<p class="text-danger">Error loading workbooks: ' + xhr.statusText + '</p>');
		});
	}`;
}
