const MASTER_MENUS = [
  [
    "Dashboard",
    [
      [
        "Dashboard",
        "/engine#/dashboard"
      ]
    ]
  ],
  [
    "Platform Agen",
    [
      [
        "Platform Agen",
        "/agents#network"
      ]
    ]
  ],
  [
    "Game Bridge",
    [
      [
        "Game Bridge",
        "/integrations"
      ]
    ]
  ],
  [
    "Game Data",
    [
      [
        "Game Data",
        "/data"
      ]
    ]
  ],
  [
    "Source Wallet",
    [
      [
        "Source Wallet",
        "/wallet"
      ]
    ]
  ],
  [
    "Manage Games",
    [
      [
        "Games",
        "/engine#/games"
      ],
      [
        "Game Log",
        "/engine#/rounds"
      ]
    ]
  ],
  [
    "Manage Users",
    [
      [
        "Active Users",
        "/engine#/players/active"
      ],
      [
        "Banned Users",
        "/engine#/players/banned"
      ],
      [
        "Email Unverified",
        "/engine#/players/email"
      ],
      [
        "Mobile Unverified",
        "/engine#/players/mobile"
      ],
      [
        "KYC Unverified",
        "/engine#/players/kyc"
      ],
      [
        "KYC Pending",
        "/engine#/players/kyc-pending"
      ],
      [
        "All Users",
        "/engine#/players/all"
      ],
      [
        "Send Notification",
        "/engine#/notify"
      ]
    ]
  ],
  [
    "Diamond Requests",
    [
      [
        "Pending Diamond",
        "/engine#/diamonds/pending"
      ],
      [
        "Approved Diamond",
        "/engine#/diamonds/approved"
      ],
      [
        "Rejected Diamond",
        "/engine#/diamonds/rejected"
      ],
      [
        "All Diamond",
        "/engine#/diamonds/all"
      ]
    ]
  ],
  [
    "Support Ticket",
    [
      [
        "Pending Ticket",
        "/engine#/tickets/pending"
      ],
      [
        "Closed Ticket",
        "/engine#/tickets/closed"
      ],
      [
        "Answered Ticket",
        "/engine#/tickets/answered"
      ],
      [
        "All Ticket",
        "/engine#/tickets/all"
      ]
    ]
  ],
  [
    "Report",
    [
      [
        "Transaction History",
        "/engine#/report/transactions"
      ],
      [
        "Login History",
        "/engine#/report/logins"
      ],
      [
        "Notification History",
        "/engine#/report/notifications"
      ],
      [
        "Transfer History",
        "/engine#/report/transfers"
      ]
    ]
  ],
  [
    "Subscribers",
    [
      [
        "Subscribers",
        "/engine#/subscribers"
      ]
    ]
  ],
  [
    "System Setting",
    [
      [
        "System Setting",
        "/engine#/settings"
      ]
    ]
  ],
  [
    "Extra",
    [
      [
        "Application",
        "/engine#/extra/application"
      ],
      [
        "Server",
        "/engine#/extra/server"
      ],
      [
        "Cache",
        "/engine#/extra/cache"
      ],
      [
        "Update",
        "/engine#/extra/update"
      ]
    ]
  ],
  [
    "Report & Request",
    [
      [
        "Report & Request",
        "/engine#/report-request"
      ]
    ]
  ],
  [
    "Functional QA",
    [
      [
        "Functional QA",
        "/engine#/parity"
      ]
    ]
  ],
  [
    "Pengaturan",
    [
      [
        "General Setting",
        "/engine#/setting/general"
      ],
      [
        "Logo and Favicon",
        "/engine#/setting/logo"
      ],
      [
        "System Configuration",
        "/engine#/setting/configuration"
      ],
      [
        "Notification Setting",
        "/engine#/setting/notification"
      ],
      [
        "SEO Configuration",
        "/engine#/setting/seo"
      ],
      [
        "Manage Templates",
        "/engine#/content/template"
      ],
      [
        "Manage Pages",
        "/engine#/content/page"
      ],
      [
        "Manage Frontend",
        "/engine#/content/frontend"
      ],
      [
        "KYC Setting",
        "/engine#/setting/kyc"
      ],
      [
        "Social Login Setting",
        "/engine#/setting/social"
      ],
      [
        "Language",
        "/engine#/setting/language"
      ],
      [
        "Extensions",
        "/engine#/setting/extensions"
      ],
      [
        "Cron Job Setting",
        "/engine#/setting/cron"
      ],
      [
        "Policy Pages",
        "/engine#/content/policy"
      ],
      [
        "Maintenance Mode",
        "/engine#/setting/maintenance"
      ],
      [
        "GDPR Cookie",
        "/engine#/setting/gdpr"
      ],
      [
        "Custom CSS",
        "/engine#/setting/css"
      ],
      [
        "Sitemap XML",
        "/engine#/setting/sitemap"
      ],
      [
        "Robots txt",
        "/engine#/setting/robots"
      ]
    ]
  ],
  [
    "Akun & operasional",
    [
      [
        "Security Center",
        "/security"
      ],
      [
        "Profil",
        "/engine#/profile"
      ],
      [
        "Notification Center",
        "/engine#/activity"
      ],
      [
        "Cron Setup",
        "/engine#/cron"
      ]
    ]
  ]
];
(() => {
  'use strict';
  // MASTER_MENUS is generated from the master route inventory below.
  const ownAgent = location.pathname === '/agency';
  const agencyPage = ownAgent || location.pathname === '/agents';
  let dialog;
  const button = (text, tag='button') => { const el=document.createElement(tag); el.className='pg-nav-button';el.textContent=text;if(tag==='button')el.type='button';return el; };
  function menu() {
    if (!dialog) { dialog=document.createElement('dialog');dialog.id='pg-main-menu';document.body.append(dialog); }
    dialog.replaceChildren();
    const head=document.createElement('div');head.className='pg-menu-head';
    const title=document.createElement('h2');title.textContent=ownAgent?'Menu agen':'Menu utama Playground';
    const close=button('Tutup');close.onclick=()=>dialog.close();head.append(title,close);dialog.append(head);
    const note=document.createElement('p');note.textContent=ownAgent?'Akses sesuai peran dan agen Anda.':'Operasional agen berada di Platform Agen. Menu GameOps memakai data sumber/legacy yang terpisah.';dialog.append(note);
    const groups=ownAgent?[]:MASTER_MENUS;
    if(agencyPage)groups.unshift(['Agen terpilih',Array.from(document.querySelectorAll('.sidebar [data-view]')).map(a=>[a.textContent,location.pathname+location.search+a.getAttribute('href')])]);
    const grid=document.createElement('div');grid.className='pg-menu-grid';
    const deferred=href=>/\/players\/(email|mobile|kyc|kyc-pending)$|\/subscribers$|\/extra\/(cache|update)$|\/content\/(template|frontend)$|\/setting\/(configuration|notification|kyc|social|language|extensions|gdpr|css)$/.test(href);
    const technical=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Rancangan teknis / belum aktif';technical.append(summary);
    for(const [name,items] of groups){const section=document.createElement('section');const h=document.createElement('h3');h.textContent=name;section.append(h);
      for(const [label,href] of items){const a=document.createElement('a');a.href=href;a.textContent=label;a.onclick=()=>dialog.close();if(deferred(href)){technical.append(a);}else section.append(a);}grid.append(section);}
    if(!ownAgent && agencyPage)groups.shift();
    if(ownAgent && document.getElementById('logout')){const out=button('Keluar');out.onclick=()=>{dialog.close();document.getElementById('logout').click();};grid.append(out);}
    dialog.append(grid);if(technical.children.length>1)dialog.append(technical);dialog.showModal();
  }
  function attach(){
    if(ownAgent&&!document.querySelector('.sidebar [data-view]'))return;
    let parent,after;
    if(document.querySelector('.workspace .topbar')){parent=document.querySelector('.workspace');after=null;}
    else if(document.querySelector('.content-wrap .topbar')){parent=document.querySelector('.content-wrap');after=parent.querySelector('.topbar');}
    else if(document.querySelector('.main > header.top')){parent=document.querySelector('.main');after=parent.querySelector('header.top');}
    else if(document.querySelector('body > header')){parent=document.body;after=document.querySelector('body > header');}
    else return;
    if(parent.querySelector(':scope > .pg-navigation'))return;
    const bar=document.createElement('nav');bar.className='pg-navigation';bar.setAttribute('aria-label','Navigasi Playground');
    const back=button('← Kembali','a');back.href=ownAgent?location.pathname+location.search+'#overview':'/engine';back.setAttribute('aria-label',ownAgent?'Kembali ke ringkasan agen':'Kembali ke master Playground');
    const main=button('☰ Menu utama');main.onclick=menu;main.setAttribute('aria-haspopup','dialog');bar.append(back,main);
    if(!ownAgent){const agents=button('Platform Agen','a');agents.href='/agents';bar.append(agents);}
    if(after)after.after(bar);else parent.prepend(bar);
  }
  new MutationObserver(attach).observe(document.body,{childList:true,subtree:true});attach();
})();
