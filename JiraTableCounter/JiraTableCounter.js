// ==UserScript==
// @name        JIRA Table Counter
// @namespace   https://github.com/RayWangQvQ/Ray.Tampermonkey/
// @description Displays the total amount of table columns
// @include     https://*jira*
// @author      Ray
// @require     http://ajax.googleapis.com/ajax/libs/jquery/2.1.3/jquery.min.js
// @require     https://gist.github.com/raw/2625891/waitForKeyElements.js
// @version     0.0.1
// @icon        https://raw.githubusercontent.com/RayWangQvQ/Ray.Tampermonkey/main/JiraStoryCounter/jira-software_logo.png
// @grant       none
// @license     MIT
// ==/UserScript==

this.$ = this.jQuery = jQuery.noConflict(true);

waitForKeyElements('.issue-table', getNumPoints);
waitForKeyElements('#issue-table', getNumPoints);

// jNode is the table
function getNumPoints(jNode) {
    var columns = {};

    var columnHeaders = jNode.find('.rowHeader');
    columnHeaders.each(function () {
        $(this).children('th').each(function () {
            var id = $(this).attr('data-id');
            columns[id] = 0;
            //$(this).children('span').append(' (' + columns[id] + ')');
        });
    });

    var rows = jNode.find('.issuerow');
    rows.each(function () {
        var row = $(this);
        var tds = row.children('td');
        tds.each(function () {
            var td = $(this);

            var columnId = td.attr('class');
            console.log(columnId);

            var point = parseInt(td.html(), 10)
            console.log(point);

            if (point > 0) {
                columns[columnId] += point;
            }
        })
    });

    columnHeaders.each(function () {
        $(this).children('th').each(function () {
            var id = $(this).attr('data-id');
            var totalCount = columns[id];
            if (totalCount > 0) {
                $(this).children('span').append(' (' + totalCount + ')');
            }
        });
    });


    console.log(columns);
}