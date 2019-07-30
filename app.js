'use strict';
const puppeteer = require('puppeteer');
const {setDefaultOptions} = require('expect-puppeteer');
setDefaultOptions({timeout: 5000});
const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const axios = require('axios');
const inquirer = require('inquirer');
const rp = require('request-promise');
const {MemoryCookieStore} = require('magic-cookie');
// const argv = require('minimist')(process.argv.slice(2));

// const ui = new inquirer.ui.BottomBar();
function delay(timeout) {
    return new Promise((resolve) => {
        setTimeout(resolve, timeout);
    });
}

function _logDebug(message) {
    console.log(message);
    // ui.clean();
    // ui.log.write(message);
}

function _logError(message) {
    console.log("ERROR:" + message);
    // ui.log.write(message);
}

async function saveCache(config, lastPackage) {
    let Cache = await fetchFile(config.uploadCache);
    if (!Cache) {
        Cache = {
            "lastUpload": lastPackage,
            "previousUploads": []
        }
    } else {
        Cache["previousUploads"].push(Cache["lastUpload"]);
        Cache["lastUpload"] = lastPackage;
    }
    let CacheString = JSON.stringify(Cache);
    try {
        fs.writeFileSync('.uploadCache', CacheString);
        _logDebug('Cache has been updated');
    } catch (e) {
        _logDebug('ERROR: could not save cache!');
    }
}

async function saveLocally(config, browser, page, agentID, internalID) {
    const RETRIEVE_SELECTOR = 'button.outline:nth-child(1)';
    let headers = {
        'Cookie': (await page.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join(';')
    };
    let id = "#ID-" + internalID;
    await page.click(id);
    let fileName = internalID + ".zip";
    let downloadPath = path.resolve(config.downloadFolderPath, agentID);
    let savePath = path.resolve(downloadPath, fileName);
    await mkdirp(downloadPath);
    const interceptedRequest = await new Promise((resolve) => {
        page.click(RETRIEVE_SELECTOR);
        browser.on('targetcreated', async target => {
            resolve(target._targetInfo.url);
        });
    });
    return await axios.get(interceptedRequest, {
        headers,
        responseType: 'stream',
        transformResponse: [async (data) => {
            await new Promise((resolve, reject) => {
                const writeStream = fs.createWriteStream(savePath);
                data.on('end', (err) => {
                    if (err) reject();
                    resolve(fileName);
                });
                data.pipe(writeStream);
            });
        }]
    });
}

async function getPackageList(page) {
    return await page.evaluate(() => {
        const packs = document.querySelectorAll(".tableData > tbody:nth-child(2) > tr:not([aria-hidden])");
        let packInfoArray = [];
        for (let i = 0; i < packs.length; i++) {
            let packInfo = {};
            console.log("Getting Pack: " + i);
            packInfo["uploadedBy"] = [];
            packInfo["uploadedDate"] = [];
            packInfo["subTitles"] = [];
            packInfo["kQueryVersion"] = "";
            packInfo["freezeVersions"] = "";
            packInfo["InternalID"] = "";
            //Uploaded By
            if (packs[i].querySelectorAll("td:nth-child(2)")[0].textContent) {
                packInfo["uploadedBy"] = packs[i].querySelectorAll("td:nth-child(2)")[0].textContent;
            }
            //Uploaded Date
            if (packs[i].querySelectorAll("td:nth-child(3)")[0].textContent) {
                packInfo["uploadedDate"] = packs[i].querySelectorAll("td:nth-child(3)")[0].textContent;
            }
            //Package Info
            if (packs[i].querySelectorAll("td:nth-child(4) > div > div")) {
                let packInfoDivs = packs[i].querySelectorAll("td:nth-child(4) > div > div");
                for (let x = 0; x < packInfoDivs.length; x++) {
                    //Get Internal ID
                    if (packInfoDivs[x].innerText.includes("Internal ID:")) {
                        packInfo["InternalID"] = packInfoDivs[x].innerText.replace("Internal ID:", "").trim();
                        packs[i].querySelector("td:nth-child(4)").id = "ID-" + packInfo["InternalID"];
                    }
                    //Get Sub-Titles
                    if (packInfoDivs[x].hasAttribute("title")) {
                        packInfo["subTitles"].push(packInfoDivs[x].getAttribute("title"));
                    }
                }
            }
            //KQuery Version
            if (packs[i].querySelectorAll("td:nth-child(5)")[0].textContent) {
                packInfo["kQueryVersion"] = packs[i].querySelectorAll("td:nth-child(5)")[0].textContent;
            }
            //Freeze Version
            if (packs[i].querySelectorAll("td:nth-child(6)")[0].textContent) {
                packInfo["freezeVersions"] = packs[i].querySelectorAll("td:nth-child(6)")[0].textContent;
            }
            let name = function () {
                let temp = "Internal ID: " + packInfo["InternalID"] + " - " + packInfo["kQueryVersion"] + " ";
                packInfo["subTitles"].forEach(function (title) {
                    temp += title + " ";
                });
                return temp;
            };
            packInfo.short = packInfo["InternalID"];
            packInfo.name = name();
            packInfo.value = packInfo["InternalID"];
            packInfoArray.push(packInfo);
        }
        return packInfoArray;
    });
}

async function askAgent(page) {
    await page.waitForSelector('.headerSelectBox > select > option');
    let agentList = await page.evaluate(({}) => {
        const agents = document.querySelectorAll('.headerSelectBox > select > option');
        console.log("agents: " + agents.length);
        return Array.from(agents).map(function (agent) {
            return {
                value: agent.getAttribute('value'),
                name: agent.textContent,
                short: agent.textContent,
            };
        });
    }, {});
    agentList.shift(); // remove the choose option
    return await inquirer.prompt([{
        type: 'list',
        message: 'Select an agent',
        name: 'selectedAgent',
        choices: agentList,
    }]);
}

async function askWorkStream(page) {
    await page.waitForSelector('.headerSelectBox > select > option');
    if (await page.$('.headerSelectWorkstream') !== null) {
        let workStreamList = await page.evaluate(({}) => {
            const workStreams = document.querySelectorAll('.headerSelectWorkstream > select > option');
            console.log("workStreams: " + workStreams.length);
            return Array.from(workStreams).map(function (workStream) {
                if (workStream.textContent === 'main') {
                    return {
                        value: 'Workstream_0',
                        name: "Workstream_0 (" + workStream.textContent + ")",
                        short: "Workstream_0 (" + workStream.textContent + ")",
                    }
                } else {
                    return {
                        value: workStream.getAttribute('value'),
                        name: workStream.textContent,
                        short: workStream.textContent,
                    }
                }
            });
        }, {});
        return await inquirer.prompt([{
            type: 'list',
            message: 'Select an agent',
            name: 'selectedWorkStream',
            choices: workStreamList,
        }]);
    } else {
        return {
            "selectedWorkStream": "Workstream_0"
        };
    }
}

async function initializeBrowser() {
    _logDebug('Initialize Browser');
    let param = process.argv[2];
    if (param && param === "debug") {
        return await puppeteer.launch({
            headless: false,
            slowMo: 1 // slow down by 1ms
        });
    } else {
        return await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox']
        });
    }
}

async function getPage(browser, cookies) {
    let page = (await browser.pages())[0];
    if (cookies) {
        await page.setCookie(...cookies);
    }
    let param = process.argv[2];
    if (param && param === "debug") {
        page.setViewport({
            width: 1080,
            height: 920
        });
    }
    return page;
}

async function login(config, page, loginInfo) {
    _logDebug('Logging in the old fashioned way!');
    await page.goto(`https://iqstudio.${config.IQSHost}.com`);
    await page.waitForNavigation({waitUntil: 'networkidle0'});
    await page.type("#username", loginInfo.username);
    await page.type("#password", loginInfo.password);
    await page.click("#neam-login-button");
}

async function deletePackage(page, internalID, count) {
    let id = "#ID-" + internalID;
    await page.click(id);
    await page.click(".delete");
    await page.click(".destructive");
    if (count === 1) {
        count = 2;
    }
    await page.waitForFunction(count => document.querySelectorAll(".tableData > tbody:nth-child(2) > tr:not([aria-hidden])").length === (count - 1), {}, count);
    //
    // await page.waitForSelector('.tableLoadingMessage', {visible: true});
    // await page.waitForSelector('.tableLoadingMessage', {visible: false});
}

async function uploadPackage(page, count, fileName) {
    const uploadPackage = await page.$(".gwt-FileUpload");
    await uploadPackage.uploadFile(fileName);
    await page.waitForFunction(count => document.querySelectorAll(".tableData > tbody:nth-child(2) > tr:not([aria-hidden])").length === (count + 1), {}, count);
}

async function updateDownloadManifest(config, packageList, downloadedPackageId) {
    let downloadedPackage = packageList.find(function (pack) {
        return pack.InternalID === downloadedPackageId;
    });
    try {
        let manifest;
        let downloadPath = path.resolve(config.downloadFolderPath, config.agentID, '.downloadManifest');
        if (!fs.existsSync(downloadPath)) {
            await mkdirp(path.resolve(config.downloadFolderPath, config.agentID));
            manifest = {
                "AgentID": config.agentID,
                "packages": []
            };
            _logDebug('No download manifest - creating one');
        } else {
            manifest = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));
        }
        manifest.packages.push(downloadedPackage);
        fs.writeFileSync(downloadPath, JSON.stringify(manifest, null, 4));
        _logDebug('Updated download manifest');
    } catch (e) {
        console.log("Error: an error occurred: " + e);
    }
}

async function goToPreviewPage(config, page, agent, workStream) {
    let KQPackageWorkStream = "";
    if (workStream && workStream !== "Workstream_0") {
        KQPackageWorkStream = ";workstream=" + workStream
    }
    await page.goto(`https://iqstudio.${config.IQSHost}.com/#!chat;agent=${agent}` + KQPackageWorkStream, {waitUntil: 'networkidle0'});
    await delay(1000);
    await page.waitFor(() => document.querySelector(".gwt-Button.outline:not([title='Start a fresh chat (empty the context)']"));
    await page.evaluate(() => {
        document.querySelector(".gwt-Button.outline:not([title='Start a fresh chat (empty the context)']").id = "ReloadBtn";
    });
    await page.waitForSelector("#ReloadBtn");
}

async function goToKQPage(config, page, agent, workStream = "Workstream_0") {
    let KQPackageWorkStream = "";
    if (workStream && workStream !== "Workstream_0") {
        KQPackageWorkStream = ";workstream=" + workStream
    }
    await page.goto(`https://iqstudio.${config.IQSHost}.com/#!kQueryPackage;agent=${agent}` + KQPackageWorkStream, {waitUntil: 'networkidle0'});
    await page.waitFor(() => document.querySelector('.tableData > tbody:nth-child(2) > tr'));
}

async function goToTopicHierarchy(config, page, agent, workStream = "Workstream_0") {
    let KQPackageWorkStream = "";
    if (workStream && workStream !== "Workstream_0") {
        KQPackageWorkStream = ";workstream=" + workStream
    }
    await page.goto(`https://iqstudio.${config.IQSHost}.com/#!topicHierarchy;agent=${agent}` + KQPackageWorkStream, {waitUntil: 'networkidle0'}).catch((e) => {
        _logError(e);
        throw new Error("Error navigating to page");
    });
    await page.waitForSelector('.headerSelectBox > select > option').catch((e) => {
        _logError(e);
        throw new Error("Error waiting for agent selection box");
    });
}

async function goToDefaultPage(config, page) {
    await page.goto(`https://iqstudio.${config.IQSHost}.com/`, {waitUntil: 'networkidle0'}).catch((e) => {
        _logError(e);
        throw new Error("Error navigating to page");
    });
    await page.waitForSelector('.headerSelectBox > select > option').catch((e) => {
        _logError(e);
        throw new Error("Error waiting for agent selection box");
    });
}

async function reloadPackage(page) {
    await page.waitForSelector("#ReloadBtn");
    await delay(1000);
    const ReloadBtn = await page.$("#ReloadBtn");
    const text = await page.$eval("#ReloadBtn", elem => elem.textContent);
    if (text.trim().toUpperCase() === "LOCKED") {
        await ReloadBtn.click();
        await page.waitForSelector("#lockedPopupSheet");
        const lockedPopupSheet = await page.$("#lockedPopupSheet");
        const lockedby = await lockedPopupSheet.$eval(".gwt-Anchor", elem => elem.textContent);
        _logDebug("Preview is locked by: " + lockedby);
    } else {
        await ReloadBtn.click();
        await page.waitForSelector(".chat-contentreloaded", {timeout: 60000});
    }
    /*await page.evaluate( () => {
        Array.from( document.querySelectorAll( '.elements button' ) ).filter( element => element.textContent === 'Button text' )[0].click();
    });*/
}

async function goToAndCheck(config, page) {
    let agent, workStream;
    await goToDefaultPage(config, page);
    agent = {"selectedAgent": config.agentID ? config.agentID : undefined};
    if (!agent.selectedAgent) {
        agent = await askAgent(page);
    }
    await page.reload();
    await goToTopicHierarchy(config, page, agent.selectedAgent);
    workStream = {"selectedWorkStream": config.workStream ? config.workStream : undefined};
    if (await page.$('.headerSelectWorkstream') !== null && !workStream.selectedWorkStream) {
        workStream = await askWorkStream(page);
    }
    await goToKQPage(config, page, agent.selectedAgent, workStream.selectedWorkStream);
    return {
        "agent": agent,
        "workStream": workStream
    }
}

async function uploadAndCache(config, page, oldPackageList) {
    _logDebug('Uploading File');
    await uploadPackage(page, oldPackageList.length, config.kqueryFile);
    let newPackageList = await getPackageList(page);
    let uploadedPackageID = newPackageList[0]['InternalID'];
    _logDebug('Upload Finished - Latest Package Internal ID: ' + uploadedPackageID);
    await saveCache(config, newPackageList[0]);
}

async function reloadPreview(config, page, sessionInfo) {
    _logDebug('Reloading Preview');
    await goToPreviewPage(config, page, sessionInfo.agent.selectedAgent, sessionInfo.workStream.selectedWorkStream);
    await reloadPackage(page);
    _logDebug('Reloaded');
}

async function deletePackageCheck(config, packageList, browser, page, agent) {
    //Do I need to delete a package?
    let _deletePackage = false;
    let packageToDelete;
    let uploadCache = await fetchFile(config.uploadCache);
    if (packageList.length >= 20) {
        _deletePackage = true;
        if (config.deletePreviousCachedUpload && uploadCache) {
            let pack = packageList.find(function (pack) {
                if (uploadCache && uploadCache.lastUpload) {
                    return pack.InternalID === uploadCache.lastUpload.InternalID;
                } else {
                    return false;
                }
            });
            if (pack) {
                _logDebug('Deleting previously uploaded package');
                packageToDelete = {
                    selectedPackage: pack.InternalID
                }
            } else {
                packageToDelete = await inquirer.prompt([{
                    type: 'rawlist',
                    message: 'Please select a KQuery Package to Delete',
                    name: 'selectedPackage',
                    choices: packageList,
                }]);
            }
        } else {
            if (config.deleteLastUpload) {
                packageToDelete = {
                    selectedPackage: packageList[packageList.length - 1].InternalID
                }
            } else {
                _logDebug('Number of previously uploaded packages is 30');
                packageToDelete = await inquirer.prompt([{
                    type: 'rawlist',
                    message: 'Please select a KQuery Package to Delete',
                    name: 'selectedPackage',
                    choices: packageList,
                }]);
            }
        }
    } else if (config.deletePreviousCachedUpload) {
        if (uploadCache) {
            let pack = packageList.find(function (pack) {
                if (uploadCache && uploadCache.lastUpload) {
                    return pack.InternalID === uploadCache.lastUpload.InternalID;
                }
            });
            if (pack) {
                _deletePackage = true;
                _logDebug('Deleting previously uploaded package');
                packageToDelete = {
                    selectedPackage: pack.InternalID
                }
            }
        }
    }

    if (_deletePackage) {
        if (config.downloadBeforeDeletion) {
            _logDebug('Saving package' + packageToDelete.selectedPackage + ' first');
            await saveLocally(config, browser, page, agent.selectedAgent, packageToDelete.selectedPackage);
            _logDebug('Package ' + packageToDelete.selectedPackage + ' saved');
            await updateDownloadManifest(config, packageList, packageToDelete.selectedPackage);
        }
        await deletePackage(page, packageToDelete.selectedPackage, packageList.length);
        _logDebug('Package ' + packageToDelete.selectedPackage + ' deleted');
    }
}

async function getCredentials(config) {
    _logDebug('Getting Login Info');
    if (config && config.credentialsFile) {
        let credentials = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8'));
        return await inquirer.prompt([
            {
                type: 'input',
                message: 'Enter your username',
                name: 'username',
                default: credentials.userName
            },
            {
                type: 'password',
                message: 'Enter a Password',
                name: 'password',
                default: credentials.password,
                mask: '*'
            }
        ]);
    } else if (config && config.credentialsInfo) {
        return config.credentialsInfo;
    } else {
        return await inquirer.prompt([
            {
                type: 'input',
                message: 'Enter your username',
                name: 'username'
            },
            {
                type: 'password',
                message: 'Enter a Password',
                name: 'password',
                mask: '*'
            }
        ]);
    }
}

async function LoginWithApi(config, loginInfo) {
    _logDebug('Logging In');
    let payload = {
        'josso_cmd': 'login',
        'josso_username': loginInfo.username,
        'josso_password': loginInfo.password
    };
    const cookieMemory = new MemoryCookieStore();
    const cookieJar = rp.jar(cookieMemory);
    let options = {
        uri: `https://login.${config.IQSHost}.com/josso/signon/login.do`,
        method: "POST",
        qs: {
            josso_back_to: `https://iqstudio.${config.IQSHost}.com/josso_security_check`,
            josso_partnerapp_host: `iqstudio.${config.IQSHost}.com`,
            josso_partnerapp_ctx: `https://iqstudio.${config.IQSHost}.com/`
        },
        jar: cookieJar,
        followAllRedirects: true,
        form: payload,
    };
    try {
        await rp(options);
        return cookieMemory.getPuppeteerCookie();
    } catch (error) {
        _logDebug(error);
        return Promise.reject(error);
    }
}

async function fetchFile(file) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {
        console.log("Error: an error occurred: " + e);
    }
}

async function saveFile(file, data) {
    let CacheString = JSON.stringify(data, null, 4);
    try {
        fs.writeFileSync(file, CacheString);
        _logDebug(`${file} has been updated`);
    } catch (e) {
        _logDebug(`ERROR: could not save ${file}!`);
    }
}

async function testLogIn(config, cookies) {
    const cookieMemory = new MemoryCookieStore();
    cookieMemory.loadPuppeteerCookie(cookies);
    const cookieJar = rp.jar(cookieMemory);
    let options = {
        uri: `https://iqstudio.${config.IQSHost}.com/`,
        method: "GET",
        jar: cookieJar,
        followAllRedirects: true
    };
    let response = await rp(options).catch((error) => {
        _logError(error);
        return false;
    });
    if (response && response.includes("<title>Nuance | Nina IQ Studio</title>")) {
        //The credentials are good
        return true;
    } else if (response && response.includes("<title>Security Redirect Page</title>")) {
        return false;
    } else {
        return false;
    }
}

async function getLogInCookies(config) {
    let cookies = await fetchFile(config.loginCookie);
    let failed = false;
    let OhNo = false;
    do {
        if (config.tryCachedCredentials && !failed && cookies) {
            cookies = await fetchFile(config.loginCookie);
            failed = true;
        } else {
            if (!OhNo) {
                OhNo = true;
                cookies = await LoginWithApi(config, await getCredentials(config));
            }
        }
    } while (!await testLogIn(config, cookies) && !OhNo);
    if (OhNo) {
        return;
    }
    await saveFile(config.loginCookie, cookies);
    return cookies;
}

function run(config) {
    return new Promise(async (resolve, reject) => {
        let browser;
        try {
            // let logInCookies = await getLogInCookies(config);
            // let browser = await initializeBrowser();
            // let page = await getPage(browser, logInCookies);
            browser = await initializeBrowser();
            let page = await getPage(browser);
            await login(config, page, await getCredentials(config));
            let sessionInfo = await goToAndCheck(config, page);
            let packageList = await getPackageList(page);
            await deletePackageCheck(config, packageList, browser, page, sessionInfo.agent);
            let oldPackageList = await getPackageList(page);
            await uploadAndCache(config, page, oldPackageList);
            // await reloadPreview(config, page, sessionInfo);
            browser.close();
            return resolve();
        } catch (e) {
            browser.close();
            return reject(e);
        }
    })
}

// let Config = {
//     deletePreviousCachedUpload: false,
//     downloadBeforeDeletion: false,
//     uploadCache: ".uploadCache",
//     kqueryFile: "kquery-grunt-usaa-multichannel.zip",
//     downloadFolderPath: "./downloads",
//     loginCookie: ".cookies.json",
//     agentID: "4862049501888794490",
//     workStream: "Workstream_1",
//     tryCachedCredentials: false,
//     IQSHost: "nuance-va",
//     deleteLastUpload: true,
//     credentialsInfo: {
//         'username': "asfdasfdasfdafsdasdf",
//         'password': "asdfasdfasfasfdasfd"
//     }
// };
// run(Config).then(() => {}).catch((error) => {console.log(error);});
module.exports = run;